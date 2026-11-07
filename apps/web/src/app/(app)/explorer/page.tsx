import Link from "next/link";
import { Badge, Empty, PageHeader, Score } from "@/components/ui";
import { ROLE_LABEL, STAGE_LABEL, ago, getJobs, getPipelineViews, isDemoMode } from "@/lib/data";
import { PHASE_LABEL } from "@/lib/pipeline-view";
import { TrackingPanel } from "@/components/tracking-panel";

const FACTORS: [keyof NonNullable<Awaited<ReturnType<typeof getJobs>>[number]["breakdown"]>, string][] = [
  ["roleFit", "Role fit"], ["comp", "Compensation"], ["conversion", "Full-time conversion"], ["responsibility", "Responsibility"],
  ["flexibility", "Flexibility"], ["upside", "Career upside"], ["entrepreneurialCompat", "Fits side projects"],
];

export default async function Explorer({ searchParams }: { searchParams: Promise<{ q?: string; job?: string; min?: string }> }) {
  const sp = await searchParams;
  const [all, views] = await Promise.all([getJobs(), getPipelineViews()]);
  const q = (sp.q ?? "").toLowerCase();
  const min = Number(sp.min ?? 0) || 0;
  const rows = all.filter((j) => (!q || `${j.company} ${j.title} ${j.location}`.toLowerCase().includes(q)) && (j.score ?? 0) >= min).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const sel = all.find((j) => j.id === sp.job) ?? null;
  const pv = sel ? views.find((v) => v.jobId === sel.id) ?? null : null;

  return (
    <>
      <PageHeader title="Opportunity explorer" lede="Search everything the system has seen, including archived roles." />
      <form className="flex flex-wrap gap-3 mb-6" role="search">
        <label className="sr-only" htmlFor="q">Search jobs</label>
        <input id="q" name="q" defaultValue={sp.q} placeholder="Company, title or location" className="field md:w-80" />
        <label className="sr-only" htmlFor="min">Minimum score</label>
        <select id="min" name="min" defaultValue={sp.min ?? "0"} className="field md:w-44">
          <option value="0">Any score</option><option value="60">60 and up</option><option value="75">75 and up</option><option value="85">85 and up</option>
        </select>
        <button className="btn">Search</button>
      </form>
      <div className="grid lg:grid-cols-[1fr_380px] gap-6 items-start">
        {rows.length === 0 ? <Empty title={all.length ? "No jobs match" : "No jobs yet"} action={all.length ? "Try a lower minimum score or a shorter search." : "Add one from the Today page."} /> : (
          <ul className="panel divide-y divide-mist">
            {rows.map((j) => (
              <li key={j.id}>
                <Link href={`/explorer?job=${j.id}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`} className={`flex items-center gap-4 p-4 hover:bg-chalk ${sel?.id === j.id ? "bg-chalk" : ""}`}>
                  <span className="w-14 shrink-0 text-center"><Score value={j.score} /></span>
                  <span className="min-w-0 flex-1"><span className="block font-medium truncate">{j.title}</span><span className="block text-sm text-soft truncate">{j.company} · {j.location}</span></span>
                  <Badge tone={j.tracking?.status ? "good" : j.stage === "archived" ? "neutral" : "neutral"}>{j.tracking?.status ? (j.tracking.status[0]!.toUpperCase() + j.tracking.status.slice(1)).replace(/_/g, " ") : STAGE_LABEL[j.stage]}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <aside aria-label="Job detail" className={`panel p-5 lg:sticky lg:top-6 lg:order-none ${sel ? "order-first" : ""}`}>
          {!sel ? <p className="text-soft text-sm">Select a job to see how it scored.</p> : (
            <>
              <h2 className="font-serif text-xl">{sel.title}</h2>
              <p className="text-sm text-soft">{sel.company} · {sel.location}</p>
              <p className="text-sm mt-2">{ROLE_LABEL[sel.roleCategory]} · {sel.atsKind}{sel.salary ? ` · ${sel.salary}` : ""}{sel.deadline ? ` · closes ${sel.deadline}` : ""}</p>
              {sel.rationale && <p className="mt-3 text-sm">{sel.rationale}</p>}
              {sel.breakdown ? (
                <dl className="mt-4 space-y-2">
                  {FACTORS.map(([k, label]) => (
                    <div key={k}>
                      <div className="flex justify-between text-sm"><dt>{label}</dt><dd className="tabular-nums">{sel.breakdown![k]}</dd></div>
                      <div className="h-1.5 bg-mist rounded-full" role="presentation"><div className="h-1.5 bg-teal rounded-full" style={{ width: `${sel.breakdown![k]}%` }} /></div>
                    </div>
                  ))}
                </dl>
              ) : <p className="text-sm text-soft mt-4">No score breakdown yet.</p>}
              {pv && (
                <dl className="mt-4 pt-4 border-t border-mist text-sm grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5" aria-label="Pipeline status">
                  <dt className="text-soft">Phase</dt><dd>{pv.phase === "CLOSED" ? "Closed" : PHASE_LABEL[pv.phase]}</dd>
                  <dt className="text-soft">Source</dt><dd>{pv.sourceLabel}</dd>
                  <dt className="text-soft">Fit score</dt><dd className="tabular-nums">{pv.fitScore ?? "Not scored"}</dd>
                  <dt className="text-soft">Deadline</dt><dd>{pv.deadline ?? "None found"}</dd>
                  <dt className="text-soft">ATS</dt><dd>{pv.atsProvider}</dd>
                  <dt className="text-soft">Strategy</dt><dd>{pv.strategy ?? "Not run yet"}</dd>
                  <dt className="text-soft">Worker</dt><dd>{pv.currentActivity ?? "Idle"}</dd>
                  <dt className="text-soft">Confirmation</dt><dd>{pv.confirmation ?? "None recorded"}</dd>
                  <dt className="text-soft">Failure</dt><dd className={pv.failureReason ? "text-rust" : ""}>{pv.failureReason ?? "None"}</dd>
                  <dt className="text-soft">Next action</dt><dd className="font-medium">{pv.nextAction}</dd>
                  <dt className="text-soft">Updated</dt><dd>{ago(sel.updatedAt)}</dd>
                </dl>
              )}
              {!isDemoMode() && (
                <TrackingPanel key={sel.id} jobId={sel.id} applyUrl={sel.applyUrl ?? null} status={sel.tracking?.status ?? null} notes={sel.tracking?.notes ?? ""} followUpAt={sel.tracking?.followUpAt ?? null} />
              )}
            </>
          )}
        </aside>
      </div>
    </>
  );
}
