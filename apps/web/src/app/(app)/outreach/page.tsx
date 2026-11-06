import { Badge, Empty, PageHeader, type Tone } from "@/components/ui";
import { getContacts } from "@/lib/data";

const STEP: Record<string, Tone> = { sent: "good", scheduled: "warn", dry_run: "neutral", draft: "neutral", stopped: "bad" };
const STEP_LABEL: Record<string, string> = { sent: "Sent", scheduled: "Scheduled", dry_run: "Prepared, not sent", draft: "Draft", stopped: "Stopped" };

export default async function Outreach() {
  const cs = await getContacts();
  return (
    <>
      <PageHeader title="Contacts and outreach" lede="Replies and opt-outs stop a sequence automatically. LinkedIn and X messages are drafted for you to send." />
      {cs.length === 0 ? <Empty title="No contacts yet" action="Contacts are found after a job passes the research threshold." /> : (
        <ul className="space-y-3">
          {cs.map((c) => (
            <li key={c.id} className="panel p-4 md:p-5">
              <div className="flex flex-wrap items-start gap-2">
                <div className="mr-auto"><h2 className="font-serif text-lg">{c.name}</h2><p className="text-sm text-soft">{c.title}, {c.company}</p></div>
                <span className="text-sm text-soft">Relevance <span className="tabular-nums text-ink">{c.relevance}</span></span>
                {c.suppressed && <Badge tone="bad">Suppressed</Badge>}
              </div>
              {c.suppressReason && <p className="text-sm mt-2">{c.suppressReason}.</p>}
              <ol className="mt-3 flex flex-wrap gap-2" aria-label="Sequence steps">
                {c.sequence.map((s) => (
                  <li key={s.step} className="flex items-center gap-2 text-sm border border-mist rounded-board px-2 py-1">
                    Email {s.step}<Badge tone={STEP[s.status]!}>{STEP_LABEL[s.status]}</Badge>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
