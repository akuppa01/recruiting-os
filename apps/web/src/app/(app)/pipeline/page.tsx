import { Empty, PageHeader } from "@/components/ui";
import { PipelineBoard, type BoardJob } from "@/components/pipeline-board";
import { ROLE_LABEL, getJobs } from "@/lib/data";

export default async function Pipeline() {
  const all = await getJobs();
  const jobs = all.filter((j) => !["duplicate", "archived"].includes(j.stage) || j.tracking?.status);
  if (!jobs.length) return (<><PageHeader title="Job pipeline" /><Empty title="No jobs yet" action="Use Find jobs or Add a job on the Today page." /></>);
  const board: BoardJob[] = jobs.map((j) => ({
    id: j.id, company: j.company, title: j.title, score: j.score, role: ROLE_LABEL[j.roleCategory] ?? "",
    followUpAt: j.tracking?.followUpAt ?? null, col: j.tracking?.status ?? "new",
  }));
  return (
    <>
      <PageHeader title="Job pipeline" lede={`${jobs.length} jobs. Tick jobs in To review or Saved, then move them to the auto-apply queue.`} />
      <PipelineBoard jobs={board} />
    </>
  );
}
