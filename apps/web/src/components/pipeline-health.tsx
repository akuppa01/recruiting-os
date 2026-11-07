import { Badge } from "@/components/ui";
import { ago, type PipelineHealth as Health } from "@/lib/data";
import { sourceStatusLabel, sourceTone } from "@/lib/pipeline-view";

const pct = (n: number | null) => (n == null ? "–" : `${n}%`);

/** Compact, honest health panel. Every number comes from real rows; empty tables show an empty state, never a placeholder figure. */
export function PipelineHealth({ health }: { health: Health }) {
  const { sources, workers, queue, stats } = health;
  const depth = queue.queued + queue.leased + queue.dead + queue.failed;
  return (
    <section aria-labelledby="health" className="mb-10">
      <h2 id="health" className="text-base font-semibold mb-1">Pipeline health</h2>
      <p className="text-sm text-soft mb-4">Live state of job sources, workers, the task queue and application results.</p>
      {!health.hasData && (
        <p className="rounded-2xl border border-mist bg-paper shadow-sm p-4 text-sm text-soft">Nothing has run through the automated pipeline yet. Sources, workers and tasks appear here after the first run.</p>
      )}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-mist bg-paper shadow-sm p-4">
          <h3 className="font-medium mb-2">Job sources</h3>
          {sources.length === 0 ? <p className="text-sm text-soft">No source has reported yet.</p> : (
            <ul className="divide-y divide-mist">
              {sources.map((s) => (
                <li key={s.source} className="py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium mr-auto">{s.label}</span>
                    <Badge tone={sourceTone(s.status)}>{sourceStatusLabel(s.status)}</Badge>
                  </div>
                  <p className="text-xs text-soft">
                    {s.lastSuccessAt ? `Last success ${ago(s.lastSuccessAt)}` : "Never succeeded"} · {s.itemsLastRun} last run · {s.itemsTotal} total
                  </p>
                  {s.lastError && <p className="text-xs text-rust">{s.lastError}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-mist bg-paper shadow-sm p-4">
          <h3 className="font-medium mb-2">Workers</h3>
          {workers.length === 0 ? <p className="text-sm text-soft">No worker has checked in. Queued work waits until one starts.</p> : (
            <ul className="divide-y divide-mist">
              {workers.map((w) => (
                <li key={w.workerId} className="py-2 text-sm flex items-center gap-2">
                  <span className="min-w-0 mr-auto">
                    <span className="block font-medium truncate">{w.workerId}</span>
                    <span className="block text-xs text-soft">{w.host ?? "unknown host"} · seen {ago(w.lastSeen)}{w.currentTask ? " · working" : ""}</span>
                  </span>
                  <Badge tone={w.status === "online" ? "good" : "neutral"}>{w.status === "online" ? "Online" : "Offline"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-mist bg-paper shadow-sm p-4">
          <h3 className="font-medium mb-2">Task queue</h3>
          <dl className="grid grid-cols-5 gap-2 text-center">
            {([["Queued", queue.queued], ["Running", queue.leased], ["Done", queue.done], ["Failed", queue.failed], ["Dead", queue.dead]] as const).map(([k, v]) => (
              <div key={k}><dt className="text-xs text-soft">{k}</dt><dd className="font-serif text-xl tabular-nums">{v}</dd></div>
            ))}
          </dl>
          <p className="text-xs text-soft mt-2">{depth === 0 ? "Nothing waiting." : `${depth} not finished.`} Dead tasks exhausted their retries and need a look.</p>
        </div>

        <div className="rounded-2xl border border-mist bg-paper shadow-sm p-4">
          <h3 className="font-medium mb-2">Application results</h3>
          {stats.attempted === 0 ? <p className="text-sm text-soft">No submission has been attempted yet. Dry runs are not counted.</p> : (
            <>
              <p className="text-sm"><span className="font-serif text-2xl tabular-nums">{pct(stats.successRate)}</span> confirmed of {stats.attempted} attempted</p>
              <p className="text-xs text-soft">{stats.confirmed} confirmed · {stats.unverified} unverified · {stats.failed} failed</p>
              <ul className="mt-2 text-xs text-soft space-y-0.5">
                {Object.entries(stats.byProvider).map(([k, b]) => (<li key={k}>{k}: {b.confirmed}/{b.attempted} ({pct(b.rate)})</li>))}
              </ul>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
