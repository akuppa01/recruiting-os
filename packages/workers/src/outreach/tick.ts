import type { AutomationPolicy, Ctx, OutreachRow, Store } from "@ros/core";
import { processInbound, type Inbound } from "./replies.js";
import { sendOrDryRun, type EmailSender } from "./sender.js";
import { DAY_MS, inQuietHours, localParts, nextAllowed } from "./time.js";

export type OutreachStore = Pick<Store,
  "listOutreach" | "updateOutreach" | "suppressContact" | "raiseException" | "recordExternalAction" | "logEvent">;

export interface TickContact { id: string; email: string | null; suppressed: boolean; name: string }
export interface TickDeps {
  policy: AutomationPolicy;
  sender: EmailSender;
  fromAddress: string;
  lookupContact(contactId: string): Promise<TickContact | null>;
  /** Return new inbound messages for a sent outreach thread (e.g. via Gmail). Optional. */
  checkInbound?(row: OutreachRow): Promise<Inbound[]>;
}
export interface TickReport { sent: number; dryRun: number; failed: number; stopped: number; skippedQuiet: number; skippedCap: number; blocked: number; inbound: number }

const DONE = new Set(["sent", "dry_run"]);

/**
 * Execute due steps. Idempotent: only rows with status 'scheduled' are acted on, and each is moved to a terminal
 * status before the next is considered; a second tick with the same `now` does nothing new.
 * A failed live send is marked 'failed' and NOT retried automatically (a retry could double-send); see RUNBOOK.
 */
export async function runOutreachTick(store: OutreachStore, ctx: Ctx, now: Date, deps: TickDeps): Promise<TickReport> {
  const rep: TickReport = { sent: 0, dryRun: 0, failed: 0, stopped: 0, skippedQuiet: 0, skippedCap: 0, blocked: 0, inbound: 0 };
  const { policy } = deps;
  const all = await store.listOutreach(ctx, {});

  // 1) replies first: a reply must stop follow-ups BEFORE anything else is sent in this tick.
  if (deps.checkInbound) {
    for (const row of all.filter((r) => r.status === "sent" && r.threadId)) {
      for (const m of await deps.checkInbound(row)) {
        rep.inbound++;
        await processInbound(store, ctx, row.contactId, m);
      }
    }
  }

  const fresh = await store.listOutreach(ctx, {});
  const today = localParts(now, policy.quietHours.tz).ymd;
  let usedToday = fresh.filter((r) => r.sentAt && DONE.has(r.status) && localParts(new Date(r.sentAt), policy.quietHours.tz).ymd === today).length;
  const due = fresh
    .filter((r) => r.status === "scheduled" && r.scheduledFor && r.scheduledFor <= now.toISOString())
    .sort((a, b) => (a.scheduledFor! < b.scheduledFor! ? -1 : 1) || a.step - b.step);
  let blockedRaised = false;

  for (const row of due) {
    const contact = await deps.lookupContact(row.contactId);
    if (!contact || contact.suppressed) {
      await store.updateOutreach(ctx, row.id, { status: "stopped", stopReason: contact ? "suppressed" : "contact_missing" });
      rep.stopped++; continue;
    }
    if (!contact.email) {
      await store.updateOutreach(ctx, row.id, { status: "stopped", stopReason: "no_email" });
      await store.raiseException(ctx, { ctx, type: "missing_profile_field", entityType: "contact", entityId: contact.id, detail: `No email for ${contact.name}; outreach step ${row.step} stopped. Add an email or send manually.` });
      rep.stopped++; continue;
    }
    // follow-ups only after the previous step actually went out (sent or dry_run)
    if (row.step > 0) {
      const prev = fresh.find((r) => r.contactId === row.contactId && r.jobId === row.jobId && r.step === row.step - 1);
      if (!prev || !DONE.has(prev.status)) continue;
    }
    if (inQuietHours(now, policy.quietHours)) {
      await store.updateOutreach(ctx, row.id, { scheduledFor: nextAllowed(now, policy.quietHours).toISOString() });
      rep.skippedQuiet++; continue;
    }
    if (usedToday >= policy.maxOutreachPerDay) {
      await store.updateOutreach(ctx, row.id, { scheduledFor: new Date(now.getTime() + DAY_MS).toISOString() });
      rep.skippedCap++; continue;
    }
    const prevSent = fresh.find((r) => r.contactId === row.contactId && r.jobId === row.jobId && r.step === 0);
    const out = await sendOrDryRun(policy, deps.sender, { to: contact.email, from: deps.fromAddress, subject: row.subject, body: row.body, threadId: prevSent?.threadId ?? null });
    if (out.status === "dry_run") {
      await store.updateOutreach(ctx, row.id, { status: "dry_run", sentAt: now.toISOString() });
      await store.recordExternalAction(ctx, { system: "gmail", action: "outreach.send", status: "dry_run", entityId: row.id, detail: `step ${row.step}` });
      rep.dryRun++; usedToday++;
    } else if (out.status === "sent") {
      await store.updateOutreach(ctx, row.id, { status: "sent", sentAt: now.toISOString(), threadId: out.result.threadId });
      await store.recordExternalAction(ctx, { system: "gmail", action: "outreach.send", status: "succeeded", entityId: row.id, detail: `messageId=${out.result.messageId}` });
      rep.sent++; usedToday++;
    } else if (out.status === "blocked") {
      rep.blocked++;
      if (!blockedRaised) {
        blockedRaised = true;
        await store.raiseException(ctx, { ctx, type: "integration_not_connected", entityType: "outreach", entityId: row.id, detail: "Live outreach is enabled but the Gmail connection could not be verified. Reconnect Gmail; steps remain scheduled." });
      }
    } else {
      await store.updateOutreach(ctx, row.id, { status: "failed" });
      await store.recordExternalAction(ctx, { system: "gmail", action: "outreach.send", status: "failed", entityId: row.id, detail: out.error });
      rep.failed++;
    }
  }
  if (rep.sent + rep.dryRun + rep.failed + rep.stopped > 0) await store.logEvent(ctx, "outreach.tick", "outreach", null, { ...rep });
  return rep;
}
