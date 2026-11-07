import { PHASES, PHASE_LABEL, type PhaseOrClosed } from "@/lib/pipeline-view";

/** DISCOVER -> QUALIFY -> TAILOR -> APPLY -> SUBMITTED -> FOLLOW-UP, with the real number of jobs in each phase. */
export function LifecycleStrip({ counts }: { counts: Record<PhaseOrClosed, number> }) {
  const open = PHASES.reduce((n, p) => n + counts[p], 0);
  return (
    <nav aria-label="Pipeline lifecycle" className="mb-6">
      <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        {PHASES.map((p, i) => {
          const pct = open > 0 ? Math.round((100 * counts[p]) / open) : 0;
          return (
            <li key={p} className={`rounded-2xl border bg-paper px-3.5 py-3 shadow-sm ${counts[p] > 0 ? "border-blue-300 dark:border-blue-500/60" : "border-mist"}`}>
              <span className="block text-[11px] uppercase tracking-wide text-soft">{i + 1}. {PHASE_LABEL[p]}</span>
              <span className="block text-2xl font-semibold tabular-nums mt-0.5">{counts[p]}</span>
              <span className="block h-1 rounded-full bg-mist/60 mt-2 overflow-hidden" role="presentation">
                <span className="block h-1 rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-soft mt-2">{counts.CLOSED} closed (archived, duplicate, rejected or withdrawn). Follow-up covers outreach, interviews and offers.</p>
    </nav>
  );
}
