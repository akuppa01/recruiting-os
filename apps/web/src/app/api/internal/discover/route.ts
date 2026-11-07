import { allOwners, authorizeInternal, daySlot, internalClients, readOptionalJson, unauthorized, unavailable } from "../../../../lib/internal-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Enqueues one 'discover' task per user for this slot and returns immediately. n8n workflow A calls this daily or twice weekly.
// body: { schedule?: "daily" | "twice_weekly", force?: boolean, slot?: string }
export async function POST(req: Request) {
  if (!authorizeInternal(req)) return unauthorized();
  const c = internalClients();
  if (!c) return unavailable("Supabase is not configured");
  const body = await readOptionalJson(req);
  const schedule = body.schedule === "twice_weekly" ? "twice_weekly" : "daily";
  const now = new Date();
  const dow = now.getUTCDay();                               // Mon=1, Thu=4
  if (schedule === "twice_weekly" && body.force !== true && dow !== 1 && dow !== 4)
    return Response.json({ enqueued: 0, existing: 0, skipped: "twice_weekly schedule: not a run day" });
  const slot = typeof body.slot === "string" && body.slot ? body.slot.slice(0, 40) : daySlot(now);
  let enqueued = 0, existing = 0;
  const owners = await allOwners(c.sb);
  for (const ctx of owners) {
    const r = await c.queue.enqueue(ctx, { kind: "discover", idempotencyKey: `discover:${slot}`, payload: { schedule, slot, sources: "all" }, priority: 10 });
    if (r.created) enqueued++; else existing++;
  }
  return Response.json({ enqueued, existing, owners: owners.length, slot, schedule });
}
