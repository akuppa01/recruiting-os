import { Empty, PageHeader } from "@/components/ui";
import { getApplications, getJobs, isDemoMode } from "@/lib/data";

export default async function Analytics() {
  const [jobs, apps] = await Promise.all([getJobs(), getApplications()]);
  if (jobs.length === 0) {
    return (<><PageHeader title="Recruiting analytics" /><Empty title="Nothing to chart yet" action="Funnel and conversion numbers appear once jobs are flowing through the pipeline." /></>);
  }
  const n = (f: (j: (typeof jobs)[number]) => boolean) => jobs.filter(f).length;
  const funnel = [
    { label: "Ingested", v: jobs.length },
    { label: "Scored", v: n((j) => j.score != null) },
    { label: "Qualified or beyond", v: n((j) => ["qualified", "applying", "applied", "needs_human", "interviewing", "offer"].includes(j.stage)) },
    { label: "Applied (confirmed)", v: apps.filter((a) => a.confirmed).length },
    { label: "Interviewing", v: n((j) => j.stage === "interviewing" || j.stage === "offer") },
    { label: "Offers", v: n((j) => j.stage === "offer") },
  ];
  const max = Math.max(...funnel.map((f) => f.v), 1);
  const scored = jobs.filter((j) => j.score != null);
  const avg = scored.length ? Math.round(scored.reduce((s, j) => s + (j.score ?? 0), 0) / scored.length) : null;
  const byRole = Object.entries(jobs.reduce<Record<string, number>>((m, j) => ((m[j.roleCategory] = (m[j.roleCategory] ?? 0) + 1), m), {}));

  return (
    <>
      <PageHeader title="Recruiting analytics" lede={isDemoMode() ? "Computed from demo data." : "Computed from your pipeline."} />
      <div className="grid lg:grid-cols-[1fr_320px] gap-6">
        <section className="panel p-5" aria-labelledby="fn">
          <h2 id="fn" className="font-serif text-xl mb-4">Funnel</h2>
          <ul className="space-y-3">
            {funnel.map((f, i) => (
              <li key={f.label}>
                <div className="flex justify-between text-sm"><span>{f.label}</span><span className="tabular-nums">{f.v}{i > 0 && funnel[i - 1]!.v > 0 ? ` · ${Math.round((f.v / funnel[i - 1]!.v) * 100)}% of previous` : ""}</span></div>
                <div className="h-2 bg-mist rounded-full"><div className="h-2 bg-teal rounded-full" style={{ width: `${(f.v / max) * 100}%` }} /></div>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel p-5" aria-labelledby="mix">
          <h2 id="mix" className="font-serif text-xl mb-2">Average score</h2>
          <p className="font-serif text-4xl tabular-nums">{avg ?? "–"}</p>
          <p className="text-sm text-soft mb-5">across {scored.length} scored jobs</p>
          <h2 className="font-serif text-lg mb-2">Jobs by role</h2>
          <ul className="text-sm space-y-1">{byRole.map(([k, v]) => (<li key={k} className="flex justify-between"><span>{k.replace(/_/g, " ")}</span><span className="tabular-nums">{v}</span></li>))}</ul>
        </section>
      </div>
    </>
  );
}
