import { z } from "zod";
import { allOwners, authorizeInternal, internalClients, unauthorized, unavailable } from "../../../../lib/internal-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Called by n8n workflow C ONCE per run with every email the Gmail node found (the user's Tepper inbox is read by n8n, not by us).
// This handler validates, classifies, bulk-enqueues (one DB write) and returns. Parsing/ingesting/reply handling happens in workers.
const MAX_EMAILS = 200;
const MAX_BODY_BYTES = 1_000_000;
const MAX_TEXT_CHARS = 50_000;

const Email = z.object({
  from: z.string().min(1).max(500),
  subject: z.string().max(1000).default(""),
  text: z.string().default(""),
  date: z.string().max(100).optional(),
  messageId: z.string().min(1).max(255),
  threadId: z.string().max(255).optional(),
});
const Body = z.object({
  emails: z.array(Email).max(MAX_EMAILS),
  /** Optional while there is a single user; required to disambiguate once several users exist. */
  owner: z.object({ tenantId: z.string().uuid(), userId: z.string().uuid() }).optional(),
});

type AlertSource = "handshake" | "twelve_twenty" | "linkedin_alert" | "indeed_alert" | "ats_feed";
function alertSource(from: string): AlertSource | null {
  const f = from.toLowerCase();
  if (f.includes("joinhandshake.com")) return "handshake";
  if (f.includes("12twenty")) return "twelve_twenty";
  if (f.includes("linkedin.com")) return "linkedin_alert";
  if (f.includes("indeed.com") || f.includes("indeedmail.com")) return "indeed_alert";
  if (/greenhouse|lever\.co|ashbyhq/.test(f)) return "ats_feed";
  return null;
}

export async function POST(req: Request) {
  if (!authorizeInternal(req)) return unauthorized();
  const c = internalClients();
  if (!c) return unavailable("Supabase is not configured");

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "payload_too_large", maxBytes: MAX_BODY_BYTES }, { status: 413 });
  let json: unknown;
  try { json = raw ? JSON.parse(raw) : {}; } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
  const { emails, owner } = parsed.data;
  if (emails.length === 0) return Response.json({ received: 0, alerts: 0, replies: 0, ignored: 0, enqueued: 0, existing: 0 });

  const owners = await allOwners(c.sb);
  const ctx = owner ? owners.find((o) => o.tenantId === owner.tenantId && o.userId === owner.userId) : owners.length === 1 ? owners[0] : undefined;
  if (!ctx) return Response.json({ error: owner ? "unknown_owner" : "owner_required", detail: owner ? undefined : "more than one user exists: send { owner: { tenantId, userId } }" }, { status: 400 });

  // Only threads we started count as replies; everything else the Gmail query returned is ignored.
  const threadIds = [...new Set(emails.map((e) => e.threadId).filter((t): t is string => !!t))];
  let ourThreads = new Set<string>();
  if (threadIds.length) {
    const { data, error } = await c.sb.from("outreach_messages").select("thread_id").eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId).in("thread_id", threadIds);
    if (error) return Response.json({ error: "lookup_failed" }, { status: 500 });
    ourThreads = new Set((data ?? []).map((r: { thread_id: string | null }) => r.thread_id).filter((t): t is string => !!t));
  }

  const seen = new Set<string>();
  let alerts = 0, replies = 0, ignored = 0;
  const rows: Array<Record<string, unknown>> = [];
  for (const e of emails) {
    if (seen.has(e.messageId)) continue;                    // duplicate within this batch
    seen.add(e.messageId);
    const source = alertSource(e.from);
    const isReply = !source && !!e.threadId && ourThreads.has(e.threadId);
    if (!source && !isReply) { ignored++; continue; }
    if (source) alerts++; else replies++;
    rows.push({
      tenant_id: ctx.tenantId, user_id: ctx.userId, kind: source ? "discover" : "outreach",
      idempotency_key: `gmail:${e.messageId}`, priority: source ? 20 : 40, max_attempts: 3,
      payload: { via: "gmail", ...(source ? { source } : { reply: true }), email: { from: e.from, subject: e.subject, text: e.text.slice(0, MAX_TEXT_CHARS), date: e.date, messageId: e.messageId, threadId: e.threadId } },
    });
  }

  let enqueued = 0;
  if (rows.length) {
    // One round trip. ignoreDuplicates returns only newly inserted rows, so re-sent emails (n8n re-reads the last 2 days) never duplicate.
    const { data, error } = await c.sb.from("tasks").upsert(rows, { onConflict: "tenant_id,user_id,idempotency_key", ignoreDuplicates: true }).select("id");
    if (error) return Response.json({ error: "enqueue_failed", detail: error.message }, { status: 500 });
    enqueued = (data ?? []).length;
  }
  return Response.json({ received: emails.length, alerts, replies, ignored, enqueued, existing: rows.length - enqueued });
}
