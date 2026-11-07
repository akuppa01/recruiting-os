import Link from "next/link";
import { QuickIngest } from "@/components/quick-ingest";
import { DiscoverButton } from "@/components/discover-button";
import { Badge, Empty, PageHeader } from "@/components/ui";
import { STAGE_LABEL, ago, getExceptions, getJobs, getUpdates, isDemoMode } from "@/lib/data";

export default async function CommandCenter() {
  const [jobs, exceptions, updates] = await Promise.all([getJobs(), getExceptions(), getUpdates()]);
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

  return (
    <>
      <PageHeader title="Today" lede={day} />
      <div className="flex flex-col">

      {/* Mobile-first order: things needing you, replies, quick add, then the board. */}
      <section aria-labelledby="prio" className="mb-8 order-1">
        <h2 id="prio" className="font-serif text-xl mb-3">Priorities for today</h2>
        <p className="text-sm text-soft mb-3">Saved {counts("saved")} · Applied {counts("applied")} · Interviewing {counts("interviewing")} · Offer {counts("offer")} · Rejected {counts("rejected")}</p>
        {followUps.length + saved.length + closing.length + toReview.length === 0 ? (
          <p className="text-soft">Nothing queued. Use Find jobs or Add a job below.</p>
        ) : (
          <div className="panel divide-y divide-mist">
            {([["Follow up today", followUps], ["Closing within 7 days", closing], ["Saved, not applied yet", saved], ["Top matches to review", toReview]] as const).map(([label, list]) =>
              list.length === 0 ? null : (
                <div key={label} className="p-4">
                  <p className="text-sm font-medium mb-2">{label}</p>
                  <ul className="space-y-1.5">
                    {list.map((j) => (
                      <li key={j.id} className="flex items-center gap-3 text-sm">
                        <span className="tabular-nums w-8 text-soft">{j.score ?? "–"}</span>
                        <Link href={`/explorer?job=${j.id}`} className="underline truncate">{j.company}: {j.title}</Link>
                        {label === "Closing within 7 days" && <span className="ml-auto text-xs text-soft whitespace-nowrap">closes {j.deadline}</span>}
                        {label === "Follow up today" && <span className="ml-auto text-xs text-soft whitespace-nowrap">due {j.tracking?.followUpAt}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        )}
      </section>

      <section aria-labelledby="attn" className="mb-8 order-2">
        <h2 id="attn" className="font-serif text-xl mb-3">
          {open.length ? `${open.length} ${open.length === 1 ? "thing needs" : "things need"} you` : "Nothing needs you"}
        </h2>
        {open.length === 0 ? (
          <p className="text-soft">No open exceptions. New ones will show up here and in your inbox.</p>
        ) : (
          <ul className="panel divide-y divide-mist">
            {open.map((e) => (
              <li key={e.id} className="p-4 flex gap-3 items-start">
                <span className="mt-1.5 h-2 w-2 rounded-full bg-amber shrink-0" aria-hidden />
                <div className="min-w-0">
                  <p className="font-medium">{e.entity}</p>
                  <p className="text-sm text-soft">{e.detail}</p>
                </div>
                <Link href="/inbox" className="btn-quiet ml-auto shrink-0">Open</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="upd" className="mb-8 order-3 md:order-4">
        <h2 id="upd" className="font-serif text-xl mb-3">Replies and interviews</h2>
        {updates.length === 0 ? (
          <Empty title="No replies yet" action="When a recruiter or contact replies, it appears here first." />
        ) : (
          <ul className="panel divide-y divide-mist">
            {updates.map((u) => (
              <li key={u.id} className="p-4 flex items-center gap-3">
                <Badge tone={u.kind === "interview" ? "good" : u.kind === "rejection" ? "bad" : "neutral"}>{u.kind}</Badge>
                <span className="text-sm">{u.text}</span>
                <span className="ml-auto text-xs text-soft whitespace-nowrap">{ago(u.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mb-8 order-4 md:order-5 grid md:grid-cols-2 gap-4">{!isDemoMode() && <DiscoverButton />}<QuickIngest /></div>

      <section aria-labelledby="board" className="mb-8 order-5 md:order-3">
        <h2 id="board" className="font-serif text-xl mb-3">The board</h2>
        {board.length === 0 ? (
          <Empty title="Your pipeline is empty" action="Add a job above, or connect Gmail alerts in Settings." />
        ) : (
          <div className="bg-[#10212E] text-[#EDF0EE] border border-mist rounded-board overflow-hidden" role="table" aria-label="Top opportunities">
            <div role="row" className="hidden md:grid grid-cols-[3rem_1fr_1fr_9rem_6rem] gap-4 px-4 py-2 text-xs text-[#EDF0EE]/60 border-b border-[#EDF0EE]/15">
              <span role="columnheader">Score</span><span role="columnheader">Company</span><span role="columnheader">Role</span><span role="columnheader">Location</span><span role="columnheader">Status</span>
            </div>
            {board.map((j) => (
              <Link key={j.id} href={`/explorer?job=${j.id}`} role="row"
                className="grid grid-cols-[3rem_1fr_auto] md:grid-cols-[3rem_1fr_1fr_9rem_6rem] gap-x-4 gap-y-0.5 px-4 py-3 border-b border-[#EDF0EE]/10 last:border-0 hover:bg-[#EDF0EE]/5">
                <span role="cell" className="font-serif text-2xl tabular-nums row-span-2 md:row-span-1 self-center">{j.score ?? "–"}</span>
                <span role="cell" className="font-medium truncate">{j.company}</span>
                <span role="cell" className="text-[#EDF0EE]/80 truncate md:order-none col-start-2 md:col-start-auto">{j.title}</span>
                <span role="cell" className="hidden md:block text-[#EDF0EE]/70 truncate">{j.location}</span>
                <span role="cell" className={`text-sm self-center row-span-2 md:row-span-1 ${j.stage === "needs_human" ? "text-[#f0c15a]" : j.stage === "interviewing" ? "text-[#7fd6d8]" : "text-[#EDF0EE]/80"}`}>{STAGE_LABEL[j.stage]}</span>
              </Link>
            ))}
          </div>
        )}
        
      </section>
      </div>
    </>
  );
}
