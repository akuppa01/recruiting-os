import Link from "next/link";
import { Card } from "@/components/ui";
import { ago } from "@/lib/data";
import type { RunSummary } from "@/lib/pipeline-view";

function Stat({ label, value, href, tone }: { label: string; value: number; href?: string; tone?: "bad" | "good" | "warn" }) {
  const color = tone === "bad" && value > 0 ? "text-rust" : tone === "good" && value > 0 ? "text-blue-600 dark:text-blue-400" : tone === "warn" && value > 0 ? "text-amber" : "";
  const inner = (
    <>
      <span className="block text-[11px] uppercase tracking-wide text-soft">{label}</span>
      <span className={`block text-2xl font-semibold tabular-nums ${color}`}>{value}</span>
    </>
  );
  return href
    ? <Link href={href} className="block min-h-[44px] rounded-xl px-1 py-0.5 hover:bg-chalk">{inner}</Link>
    : <div className="px-1 py-0.5">{inner}</div>;
}

/** What the automated pipeline did most recently. Every figure is read from Supabase; before the first run it says so. */
export function RunSummaryCard({ run }: { run: RunSummary }) {
  return (
    <section aria-labelledby="run" className="mb-6">
      <h2 id="run" className="text-base font-semibold mb-2">Latest run</h2>
      <Card className="p-4">
        {!run.hasRun ? (
          <p className="text-sm text-soft">The automated pipeline hasn&apos;t run yet. After the first scheduled or manual run, discovery and application results show up here.</p>
        ) : (
          <>
            <p className="text-sm text-soft mb-3">
              {run.lastDiscoveryAt ? `Last discovery ${ago(run.lastDiscoveryAt)}, ${run.jobsFoundLastRun} job${run.jobsFoundLastRun === 1 ? "" : "s"} found.` : "No discovery run has finished yet."}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              <Stat label="Queued" value={run.applyQueued} />
              <Stat label="Running" value={run.applyRunning} />
              <Stat label="Confirmed" value={run.confirmed} href="/applications" tone="good" />
              <Stat label="Unconfirmed" value={run.unverified} href="/applications" tone="warn" />
              <Stat label="Failed" value={run.failed} href="/applications" tone="bad" />
              <Stat label="Needs you" value={run.openExceptions} href="/inbox" tone="warn" />
            </div>
          </>
        )}
      </Card>
    </section>
  );
}
