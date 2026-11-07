import { PHASES, PHASE_LABEL, type PhaseOrClosed } from "@/lib/pipeline-view";

/** DISCOVER -> QUALIFY -> TAILOR -> APPLY -> CONNECT -> INTERVIEW -> OFFER, with the real number of jobs in each phase. */
export function LifecycleStrip({ counts }: { counts: Record<PhaseOrClosed, number> }) {
  return (
    <nav aria-label="Pipeline lifecycle" className="mb-6">
      <ol className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        {PHASES.map((p, i) => (
          <li key={p} className={`panel px-3 py-2 ${counts[p] > 0 ? "border-teal" : ""}`}>
            <span className="block text-xs text-soft">{i + 1}. {PHASE_LABEL[p]}</span>
            <span className="font-serif text-2xl tabular-nums">{counts[p]}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-soft mt-2">{counts.CLOSED} closed (archived, duplicate, rejected or withdrawn).</p>
    </nav>
  );
}
