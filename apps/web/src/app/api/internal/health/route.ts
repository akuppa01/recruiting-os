import { authorizeInternal, internalClients, unauthorized, unavailable } from "../../../../lib/internal-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Queue and worker health for n8n alerts and the dashboard. Counts only: no payloads, no personal data.
export async function GET(req: Request) {
  if (!authorizeInternal(req)) return unauthorized();
  const c = internalClients();
  if (!c) return unavailable("Supabase is not configured");
  const nowIso = new Date().toISOString();
  const [tasks, workers] = await Promise.all([
    c.sb.from("tasks").select("kind,status,run_after,lease_until,created_at").limit(5000),
    c.sb.from("worker_heartbeats").select("worker_id,host,kinds,last_seen,current_task").order("last_seen", { ascending: false }).limit(50),
  ]);
  if (tasks.error) return Response.json({ error: tasks.error.message }, { status: 500 });
  const byStatus: Record<string, number> = {}, byKind: Record<string, Record<string, number>> = {};
  let staleLeases = 0, oldestQueued: number | null = null;
  for (const t of tasks.data ?? []) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    (byKind[t.kind] ??= {})[t.status] = (byKind[t.kind]?.[t.status] ?? 0) + 1;
    if (t.status === "leased" && t.lease_until && t.lease_until < nowIso) staleLeases++;
    if (t.status === "queued" && t.run_after <= nowIso) {
      const age = (Date.parse(nowIso) - Date.parse(t.created_at)) / 1000;
      oldestQueued = oldestQueued === null ? age : Math.max(oldestQueued, age);
    }
  }
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const liveWorkers = (workers.data ?? []).filter((w) => w.last_seen >= fiveMinAgo);
  return Response.json({
    ok: (byStatus.dead ?? 0) === 0 && staleLeases === 0,
    queue: { byStatus, byKind, staleLeases, oldestReadyQueuedSeconds: oldestQueued, deadLetters: byStatus.dead ?? 0 },
    workers: { live: liveWorkers.length, recent: (workers.data ?? []).slice(0, 10) },
  });
}
