import { Empty, PageHeader } from "@/components/ui";
import { AutoRefresh } from "@/components/auto-refresh";
import { LifecycleStrip } from "@/components/lifecycle-strip";
import { PipelineBoard, type BoardJob } from "@/components/pipeline-board";
import { ROLE_LABEL, getJobs, getPipelineViews } from "@/lib/data";
import { derivePhase, phaseCounts } from "@/lib/pipeline-view";

export default async function Pipeline() {
  const [all, views] = await Promise.all([getJobs(), getPipelineViews()]);
  const jobs = all.filter((j) => !["duplicate", "archived"].includes(j.stage) || j.tracking?.status);
  if (!jobs.length) return (<><PageHeader title="Job pipeline" /><Empty title="No jobs yet" action="Use Find jobs or Add a job on the Today page." /></>);
  const board: BoardJob[] = jobs.map((j) => ({
    id: j.id, company: j.company, title: j.title, score: j.score, role: ROLE_LABEL[j.roleCategory] ?? "",
    followUpAt: j.tracking?.followUpAt ?? null, col: j.tracking?.status ?? "new",
  }));
  // Real task rows refine the phase when they exist; otherwise the phase comes from the job's stage and your tracking status alone.
  const counts = phaseCounts(views.length ? views.map((v) => v.phase) : all.map((j) => derivePhase({ stage: j.stage, trackingStatus: j.tracking?.status ?? null, tasks: [] })));
  return (
    <>
      <PageHeader variant="apple" title="Job pipeline" lede={`${jobs.length} jobs. Tick jobs in To review or Saved, then move them to the auto-apply queue.`} />
      <AutoRefresh />
      <LifecycleStrip counts={counts} />
      <PipelineBoard jobs={board} />
    </>
  );
}
