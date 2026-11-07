import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { QuickIngest } from "@/components/quick-ingest";
import { DiscoverButton } from "@/components/discover-button";
import { LifecycleStrip } from "@/components/lifecycle-strip";
import { RunSummaryCard } from "@/components/run-summary";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { STAGE_LABEL, ago, getExceptions, getJobs, getPipelineViews, getRunSummary, getUpdates, isDemoMode } from "@/lib/data";
import { derivePhase, phaseCounts } from "@/lib/pipeline-view";

export default async function CommandCenter() {
  const [jobs, exceptions, updates, views, run] = await Promise.all([getJobs(), getExceptions(), getUpdates(), getPipelineViews(), getRunSummary()]);
  const open = exceptions.filter((e) => !e.resolved);
  const live = jobs.filter((j) => !["archived", "duplicate", "rejected", "withdrawn"].includes(j.stage));
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const followUps = jobs.filter((j) => j.tracking?.followUpAt && j.tracking.followUpAt <= today);
  const saved = jobs.filter((j) => j.tracking?.status === "saved");
  const closing = live.filter((j) => !j.tracking?.status && j.deadline && j.deadline >= today && j.deadline <= soon);
  const toReview = live.filter((j) => !j.tracking?.status && j.score != null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 5);
  const counts = (s: string) => jobs.filter((j) => j.tracking?.status === s).length;
  const board = [...live].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 8);
  const day = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  // Real task rows refine the phase when they exist; otherwise it comes from the job's stage and your tracking status alone.
  const phases = phaseCounts(views.length ? views.map((v) => v.phase) : jobs.map((j) => derivePhase({ stage: j.stage, trackingStatus: j.tracking?.status ?? null, tasks: [] })));

  return (
    <>
      <AutoRefresh />
      <PageHeader variant="apple" title="Today" lede={day} />
      <div className="flex flex-col">

      <div className="order-first">
        <LifecycleStrip counts={phases} />
        <RunSummaryCard run={run} />
      </div>

      {/* Mobile-first order: things needing you, replies, quick add, then the board. */}
      <section aria-labelledby="prio" className="mb-8 order-1">
        <h2 id="prio" className="text-base font-semibold mb-2">Priorities for today</h2>
        <p className="text-sm text-soft mb-3">Saved {counts("saved")} · Queued {counts("queued")} · Applied {counts("applied")} · Ready to contact {counts("ready_to_contact")} · Interviewing {counts("interviewing")} · Offer {counts("offer")} · Rejected {counts("rejected")}</p>
        {followUps.length + saved.length + closing.length + toReview.length === 0 ? (
          <p className="text-soft">Nothing queued. Use Find jobs or Add a job below.</p>
        ) : (
          <Card className="divide-y divide-mist">
            {([["Follow up today", followUps], ["Closing within 7 days", closing], ["Saved, not applied yet", saved], ["Top matches to review", toReview]] as const).map(([label, list]) =>
              list.length === 0 ? null : (
                <div key={label} className="p-4">
                  <p className="text-sm font-medium mb-2">{label}</p>
                  <ul className="space-y-1">
                    {list.map((j) => (
                      <li key={j.id} className="flex items-center gap-3 text-sm min-h-[44px]">
                        <span className="tabular-nums w-8 text-soft shrink-0">{j.score ?? "–"}</span>
                        <Link href={`/explorer?job=${j.id}`} className="underline truncate">{j.company}: {j.title}</Link>
                        {label === "Closing within 7 days" && <span className="ml-auto text-xs text-soft whitespace-nowrap">closes {j.deadline}</span>}
                        {label === "Follow up today" && <span className="ml-auto text-xs text-soft whitespace-nowrap">due {j.tracking?.followUpAt}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </Card>
        )}
      </section>

      <section aria-labelledby="attn" className="mb-8 order-2">
        <h2 id="attn" className="text-base font-semibold mb-3">
          {open.length ? `${open.length} ${open.length === 1 ? "thing needs" : "things need"} you` : "Nothing needs you"}
        </h2>
        {open.length === 0 ? (
          <p className="text-soft">No open exceptions. New ones will show up here and in your inbox.</p>
        ) : (
          <Card className="divide-y divide-mist">
            <ul className="divide-y divide-mist">
              {open.map((e) => (
                <li key={e.id} className="p-4 flex gap-3 items-start">
                  <span className="mt-1.5 h-2 w-2 rounded-full bg-amber shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <p className="font-medium">{e.entity}</p>
                    <p className="text-sm text-soft break-words">{e.detail}</p>
                  </div>
                  <Link href="/inbox" className="btn-quiet rounded-xl ml-auto shrink-0">Open</Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section aria-labelledby="upd" className="mb-8 order-3 md:order-4">
        <h2 id="upd" className="text-base font-semibold mb-3">Replies and interviews</h2>
        {updates.length === 0 ? (
          <Empty title="No replies yet" action="When a recruiter or contact replies, it appears here first." />
        ) : (
          <Card>
            <ul className="divide-y divide-mist">
              {updates.map((u) => (
                <li key={u.id} className="p-4 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Badge tone={u.kind === "interview" ? "good" : u.kind === "rejection" ? "bad" : "neutral"}>{u.kind}</Badge>
                  <span className="text-sm min-w-0 break-words">{u.text}</span>
                  <span className="ml-auto text-xs text-soft whitespace-nowrap">{ago(u.at)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <div className="mb-8 order-4 md:order-5 grid md:grid-cols-2 gap-4">{!isDemoMode() && <DiscoverButton />}<QuickIngest /></div>

      <section aria-labelledby="board" className="mb-8 order-5 md:order-3">
        <h2 id="board" className="text-base font-semibold mb-3">Top opportunities</h2>
        {board.length === 0 ? (
          <Empty title="Your pipeline is empty" action="Add a job above, or connect Gmail alerts in Settings." />
        ) : (
          <Card>
            <ul className="divide-y divide-mist">
              {board.map((j) => (
                <li key={j.id}>
                  <Link href={`/explorer?job=${j.id}`} className="flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-chalk first:rounded-t-2xl last:rounded-b-2xl">
                    <span className="shrink-0 w-11 text-center rounded-lg bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300 text-sm font-semibold tabular-nums py-1">{j.score ?? "–"}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium truncate">{j.company}</span>
                      <span className="block text-sm text-soft truncate">{j.title}{j.location && j.location !== "—" ? ` · ${j.location}` : ""}</span>
                    </span>
                    <span className={`text-xs shrink-0 ${j.stage === "needs_human" ? "text-amber font-medium" : "text-soft"}`}>{j.tracking?.status ? j.tracking.status.replace(/_/g, " ") : STAGE_LABEL[j.stage]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
      </div>
    </>
  );
}
