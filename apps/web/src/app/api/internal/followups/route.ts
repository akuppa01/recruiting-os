import { SupabaseStore } from "@ros/db";
import { allOwners, authorizeInternal, hourSlot, internalClients, unauthorized, unavailable } from "../../../../lib/internal-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Counts due, scheduled outreach (follow-ups) per user and enqueues ONE 'outreach' task for users that have any.
// Sending happens in the worker through the existing outreach tick (caps, quiet hours, opt-outs); nothing is sent here.
export async function POST(req: Request) {
  if (!authorizeInternal(req)) return unauthorized();
  const c = internalClients();
  if (!c) return unavailable("Supabase is not configured");
  const store = new SupabaseStore(c.sb);
  const nowIso = new Date().toISOString();
  const slot = hourSlot();
  let enqueued = 0, existing = 0, due = 0;
  const owners = await allOwners(c.sb);
  for (const ctx of owners) {
    const dueMsgs = (await store.listOutreach(ctx, { dueBefore: nowIso })).filter((m) => m.status === "scheduled");
    if (dueMsgs.length === 0) continue;
    due += dueMsgs.length;
    const r = await c.queue.enqueue(ctx, { kind: "outreach", idempotencyKey: `followups:${slot}`, payload: { due: dueMsgs.length, slot }, priority: 30 });
    if (r.created) enqueued++; else existing++;
  }
  return Response.json({ enqueued, existing, owners: owners.length, dueMessages: due, slot });
}
