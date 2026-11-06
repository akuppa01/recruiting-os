import Link from "next/link";
import { Badge, Empty, PageHeader, Score } from "@/components/ui";
import { BOARD_STAGES, STAGE_LABEL, ROLE_LABEL, getJobs, type JobView } from "@/lib/data";

function Card({ j }: { j: JobView }) {
  return (
    <Link href={`/explorer?job=${j.id}`} className="block panel p-3 hover:border-teal">
      <div className="flex justify-between gap-2">
        <p className="font-medium text-sm">{j.company}</p><Score value={j.score} />
      </div>
      <p className="text-sm text-soft">{j.title}</p>
      <p className="text-xs text-soft mt-2">{ROLE_LABEL[j.roleCategory]}</p>
    </Link>
  );
}

export default async function Pipeline() {
  const jobs = await getJobs();
  if (!jobs.length) return (<><PageHeader title="Job pipeline" /><Empty title="No jobs yet" action="Add one from the Today page." /></>);
  return (
    <>
      <PageHeader title="Job pipeline" lede={`${jobs.length} jobs across ${BOARD_STAGES.filter((s) => jobs.some((j) => j.stage === s)).length} stages.`} />
      {/* Mobile: grouped list. Desktop: columns. */}
      <div className="md:hidden space-y-6">
        {BOARD_STAGES.map((s) => {
          const col = jobs.filter((j) => j.stage === s);
          if (!col.length) return null;
          return (
            <section key={s} aria-label={STAGE_LABEL[s]}>
              <h2 className="font-serif text-lg mb-2">{STAGE_LABEL[s]} <Badge>{col.length}</Badge></h2>
              <div className="space-y-2">{col.map((j) => <Card key={j.id} j={j} />)}</div>
            </section>
          );
        })}
      </div>
      <div className="hidden md:flex gap-4 overflow-x-auto pb-4">
        {BOARD_STAGES.map((s) => {
          const col = jobs.filter((j) => j.stage === s);
          return (
            <section key={s} aria-label={STAGE_LABEL[s]} className="w-60 shrink-0">
              <h2 className="text-sm font-medium pb-2 mb-3 border-b-2 border-ink flex justify-between">{STAGE_LABEL[s]}<span className="text-soft tabular-nums">{col.length}</span></h2>
              <div className="space-y-2">{col.length ? col.map((j) => <Card key={j.id} j={j} />) : <p className="text-xs text-soft">None</p>}</div>
            </section>
          );
        })}
      </div>
    </>
  );
}
