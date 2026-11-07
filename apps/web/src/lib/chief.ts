// Chief of Staff: deterministic, tenant-scoped database tools. No model call is needed for lookups;
// a synthesis step can be layered on later behind the cost router. Every answer is built from rows the store returned for this ctx.
import type { Ctx, JobRow, Store } from "@ros/core";

export interface ChiefAnswer { source: "database"; intent: string; answer: string; items: { label: string; detail?: string; href?: string }[] }

const DAY = 86_400_000;
const line = (j: JobRow) => `${j.normalized.company}: ${j.normalized.title}`;
const link = (j: JobRow) => `/explorer?job=${j.id}`;

export type Intent = "blocked" | "top" | "applications" | "stalled" | "replies" | "deadlines" | "outreach" | "summary";

export function detectIntent(q: string): Intent {
  const s = q.toLowerCase();
  if (/(needs? me|blocked|exception|stuck on me|action)/.test(s)) return "blocked";
  if (/(stall|stuck|old|nothing happen)/.test(s)) return "stalled";
  if (/(deadline|closing|due|expire)/.test(s)) return "deadlines";
  if (/(repl|interview|recruiter|responded)/.test(s)) return "replies";
  if (/(outreach|email|contact|sequence|follow.?up)/.test(s)) return "outreach";
  if (/(appl(y|ied|ication)|submitted)/.test(s)) return "applications";
  if (/(top|best|rank|highest|score|priorit)/.test(s)) return "top";
  return "summary";
}

export async function answerQuestion(store: Store, ctx: Ctx, question: string, now = Date.now()): Promise<ChiefAnswer> {
  const intent = detectIntent(question);
  const done = (answer: string, items: ChiefAnswer["items"] = []): ChiefAnswer => ({ source: "database", intent, answer, items });

  if (intent === "blocked") {
    const open = await store.listExceptions(ctx, true);
    if (!open.length) return done("Nothing is blocked on you right now.");
    return done(`${open.length} item(s) need you.`, open.slice(0, 10).map((e) => ({ label: e.type.replace(/_/g, " "), detail: e.detail, href: "/inbox" })));
  }

  if (intent === "applications") {
    const jobs = await store.searchJobs(ctx, { limit: 500 });
    const apps = (await Promise.all(jobs.map((j) => store.getApplicationByJob(ctx, j.id)))).filter((a) => a !== null);
    if (!apps.length) return done("No applications exist yet.");
    const confirmed = apps.filter((a) => a.confirmed).length;
    const by = (s: string) => apps.filter((a) => a.status === s).length;
    return done(`${apps.length} application record(s): ${confirmed} confirmed, ${by("dry_run")} prepared (not sent), ${by("unverified")} sent but unconfirmed, ${by("failed")} failed, ${by("pending")} pending.`);
  }

  if (intent === "replies") {
    const ev = await store.listEvents(ctx, { kind: "reply.received", limit: 20 });
    if (!ev.length) return done("No replies recorded yet.");
    const classes = ev.reduce<Record<string, number>>((m, e) => { const c = String(e.payload.class ?? "reply"); m[c] = (m[c] ?? 0) + 1; return m; }, {});
    return done(`${ev.length} recent inbound message(s): ${Object.entries(classes).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}.`);
  }

  if (intent === "outreach") {
    const msgs = await store.listOutreach(ctx, {});
    if (!msgs.length) return done("No outreach has been drafted or sent yet.");
    const by = (s: string) => msgs.filter((m) => m.status === s).length;
    return done(`${msgs.length} outreach message(s): ${by("sent")} sent, ${by("scheduled")} scheduled, ${by("dry_run")} prepared (not sent), ${by("draft")} draft, ${by("stopped")} stopped, ${by("failed")} failed.`);
  }

  const jobs = await store.searchJobs(ctx, { limit: 500 });
  const live = jobs.filter((j) => !["archived", "duplicate", "rejected", "withdrawn"].includes(j.stage));

  if (intent === "top") {
    const top = live.filter((j) => j.score).sort((a, b) => (b.score!.total) - (a.score!.total)).slice(0, 5);
    if (!top.length) return done("No scored jobs yet.");
    return done(`Top ${top.length} by score.`, top.map((j) => ({ label: `${j.score!.total} · ${line(j)}`, detail: j.score!.rationale, href: link(j) })));
  }

  if (intent === "stalled") {
    const cutoff = now - 3 * DAY;
    const stalled = live.filter((j) => ["ingested", "normalized", "researched", "scored", "qualified", "applying"].includes(j.stage) && Date.parse(j.updatedAt) < cutoff);
    if (!stalled.length) return done("No jobs have been sitting in one stage for more than 3 days.");
    return done(`${stalled.length} job(s) have not moved in over 3 days.`, stalled.slice(0, 10).map((j) => ({ label: line(j), detail: `Stage: ${j.stage}`, href: link(j) })));
  }

  if (intent === "deadlines") {
    const soon = live.filter((j) => j.normalized.deadline && Date.parse(j.normalized.deadline) >= now - DAY)
      .sort((a, b) => Date.parse(a.normalized.deadline!) - Date.parse(b.normalized.deadline!)).slice(0, 10);
    if (!soon.length) return done("No upcoming deadlines are recorded on live jobs.");
    return done(`${soon.length} upcoming deadline(s).`, soon.map((j) => ({ label: line(j), detail: `Closes ${j.normalized.deadline}`, href: link(j) })));
  }

  const [counts, open] = await Promise.all([store.pipelineCounts(ctx), store.listExceptions(ctx, true)]);
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k.replace(/_/g, " ")}: ${n}`);
  if (!parts.length) return done("No jobs yet. Add one from Today to start the pipeline.");
  return done(`${jobs.length} jobs (${parts.join(", ")}). ${open.length} open exception(s).`);
}
