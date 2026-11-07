import Link from "next/link";
import { Badge, Empty, PageHeader, Score } from "@/components/ui";
import { ROLE_LABEL, getJobs, type JobView } from "@/lib/data";

const COLUMNS = [
  { id: "new", label: "To review" }, { id: "saved", label: "Saved" }, { id: "applied", label: "Applied" },
  { id: "interviewing", label: "Interviewing" }, { id: "offer", label: "Offer" }, { id: "rejected", label: "Rejected" },
] as const;

function Card({ j }: { j: JobView }) {
  const fu = j.tracking?.followUpAt;
  return (
    <Link href={`/explorer?job=${j.id}`} className="block panel p-3 hover:border-teal">
      <div className="flex justify-between gap-2">
        <p className="font-medium text-sm">{j.company}</p><Score value={j.score} />
      </div>
      <p className="text-sm text-soft">{j.title}</p>
      <p className="text-xs text-soft mt-2">{ROLE_LABEL[j.roleCategory]}{fu ? ` · follow up ${fu}` : ""}</p>
    </Link>
  );
}

export default async function Pipeline() {
  const all = await getJobs();
  const jobs = all.filter((j) => !["duplicate", "archived"].includes(j.stage) || j.tracking?.status);
  if (!jobs.length) return (<><PageHeader title="Job pipeline" /><Empty title="No jobs yet" action="Use Find jobs or Add a job on the Today page." /></>);
  const colOf = (j: JobView) => j.tracking?.status ?? "new";
  const byScore = (a: JobView, b: JobView) => (b.score ?? -1) - (a.score ?? -1);
  return (
    <>
      <PageHeader title="Job pipeline" lede={`${jobs.length} jobs. Your status for each job, from review to offer.`} />
      <div className="md:hidden space-y-6">
        {COLUMNS.map((c) => {
          const col = jobs.filter((j) => colOf(j) === c.id).sort(byScore);
          if (!col.length) return null;
          return (
            <section key={c.id} aria-label={c.label}>
              <h2 className="font-serif text-lg mb-2">{c.label} <Badge>{col.length}</Badge></h2>
              <div className="space-y-2">{col.map((j) => <Card key={j.id} j={j} />)}</div>
            </section>
          );
        })}
      </div>
      <div className="hidden md:flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map((c) => {
          const col = jobs.filter((j) => colOf(j) === c.id).sort(byScore);
          return (
            <section key={c.id} aria-label={c.label} className="w-60 shrink-0">
              <h2 className="text-sm font-medium pb-2 mb-3 border-b-2 border-ink flex justify-between">{c.label}<span className="text-soft tabular-nums">{col.length}</span></h2>
              <div className="space-y-2">{col.length ? col.map((j) => <Card key={j.id} j={j} />) : <p className="text-xs text-soft">None</p>}</div>
            </section>
          );
        })}
      </div>
    </>
  );
}
