// Notification layer. Default adapter is a dry-run recorder: nothing is pushed unless a real adapter is configured.
import type { Ctx, Store } from "@ros/core";

export type NotifyKind =
  | "interview" | "reply" | "offer" | "rejection" | "exception" | "dead_letter"
  | "application_confirmed" | "high_score_job" | "daily_summary" | "integration_issue";
export type Priority = "urgent" | "high" | "default" | "low";

export interface Notification { kind: NotifyKind; title: string; body: string; url?: string; priority?: Priority }
export interface NotifyResult { status: "succeeded" | "failed" | "dry_run" | "suppressed"; adapter: string; detail?: string }
export interface Notifier { name: string; send(n: Notification & { priority: Priority }): Promise<NotifyResult> }

/** interview/reply/offer = push now; exceptions & DLQ = default push; daily summary = low; rest = low. */
export function priorityFor(kind: NotifyKind): Priority {
  switch (kind) {
    case "interview": case "offer": return "urgent";
    case "reply": return "high";
    case "exception": case "dead_letter": case "integration_issue": return "default";
    case "rejection": case "application_confirmed": case "high_score_job": case "daily_summary": return "low";
  }
}

/** Suppress low-priority pushes during quiet hours; urgent/high always go through. */
export function inQuietHours(now: Date, q: { startHour: number; endHour: number; tz: string }): boolean {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: q.tz }).format(now)) % 24;
  return q.startHour > q.endHour ? h >= q.startHour || h < q.endHour : h >= q.startHour && h < q.endHour;
}

export class DryRunNotifier implements Notifier {
  name = "dry_run"; sent: Notification[] = [];
  async send(n: Notification & { priority: Priority }): Promise<NotifyResult> { this.sent.push(n); return { status: "dry_run", adapter: this.name, detail: "no push sent (no adapter configured)" }; }
}

export class NtfyNotifier implements Notifier {
  name = "ntfy";
  constructor(private o: { topic: string; baseUrl?: string; token?: string; fetchImpl?: typeof fetch }) {}
  async send(n: Notification & { priority: Priority }): Promise<NotifyResult> {
    const pri = { urgent: "5", high: "4", default: "3", low: "2" }[n.priority];
    const headers: Record<string, string> = { Title: n.title, Priority: pri, Tags: n.kind };
    if (n.url) headers.Click = n.url;
    if (this.o.token) headers.Authorization = `Bearer ${this.o.token}`;
    try {
      const r = await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl ?? "https://ntfy.sh"}/${encodeURIComponent(this.o.topic)}`, { method: "POST", headers, body: n.body });
      return r.ok ? { status: "succeeded", adapter: this.name } : { status: "failed", adapter: this.name, detail: `HTTP ${r.status}` };
    } catch (e) { return { status: "failed", adapter: this.name, detail: (e as Error).message }; }
  }
}

export class PushoverNotifier implements Notifier {
  name = "pushover";
  constructor(private o: { appToken: string; userKey: string; fetchImpl?: typeof fetch }) {}
  async send(n: Notification & { priority: Priority }): Promise<NotifyResult> {
    const pri = { urgent: 1, high: 1, default: 0, low: -1 }[n.priority];
    const body = new URLSearchParams({ token: this.o.appToken, user: this.o.userKey, title: n.title, message: n.body, priority: String(pri) });
    if (n.url) body.set("url", n.url);
    try {
      const r = await (this.o.fetchImpl ?? fetch)("https://api.pushover.net/1/messages.json", { method: "POST", body });
      return r.ok ? { status: "succeeded", adapter: this.name } : { status: "failed", adapter: this.name, detail: `HTTP ${r.status}` };
    } catch (e) { return { status: "failed", adapter: this.name, detail: (e as Error).message }; }
  }
}

export function createNotifierFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): Notifier {
  if (env.NTFY_TOPIC) return new NtfyNotifier({ topic: env.NTFY_TOPIC, fetchImpl });
  if (env.PUSHOVER_APP_TOKEN && env.PUSHOVER_USER_KEY) return new PushoverNotifier({ appToken: env.PUSHOVER_APP_TOKEN, userKey: env.PUSHOVER_USER_KEY, fetchImpl });
  return new DryRunNotifier();
}

/** Send, applying priority rules + quiet hours, and record the outcome as an external action. */
export async function notify(store: Store, ctx: Ctx, notifier: Notifier, n: Notification, opts: { quiet?: { startHour: number; endHour: number; tz: string }; now?: Date } = {}): Promise<NotifyResult> {
  const priority = n.priority ?? priorityFor(n.kind);
  let res: NotifyResult;
  if (opts.quiet && (priority === "low") && inQuietHours(opts.now ?? new Date(), opts.quiet) && n.kind !== "daily_summary") {
    res = { status: "suppressed", adapter: notifier.name, detail: "quiet hours" };
  } else res = await notifier.send({ ...n, priority });
  await store.recordExternalAction(ctx, { system: `notify:${notifier.name}`, action: n.kind, status: res.status === "succeeded" ? "succeeded" : res.status === "failed" ? "failed" : "dry_run", detail: res.detail });
  return res;
}

export async function buildDailySummary(store: Store, ctx: Ctx, now = new Date()): Promise<Notification> {
  const counts = await store.pipelineCounts(ctx);
  const exceptions = await store.listExceptions(ctx, true);
  const since = new Date(now.getTime() - 86400000).toISOString();
  const events = await store.listEvents(ctx, { limit: 1000 });
  const recent = events.filter((e) => e.createdAt >= since);
  const n = (k: string) => recent.filter((e) => e.kind === k).length;
  return {
    kind: "daily_summary", title: "Recruiting OS daily summary",
    body: `Last 24h: ${n("job.ingested")} ingested, ${n("application.confirmed")} confirmed applications, ${n("application.dry_run")} dry-run, ${n("outreach.sent")} outreach sent. Pipeline: ${counts.qualified ?? 0} qualified, ${counts.applied ?? 0} applied, ${counts.interviewing ?? 0} interviewing. Open exceptions: ${exceptions.length}.`,
  };
}
