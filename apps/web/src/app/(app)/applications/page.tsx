import { Badge, Empty, ModeBadge, PageHeader, type Tone } from "@/components/ui";
import { ago, getApplications } from "@/lib/data";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  succeeded: { label: "Submitted and confirmed", tone: "good" },
  dry_run: { label: "Prepared, not sent", tone: "neutral" },
  unverified: { label: "Sent, not confirmed", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  pending: { label: "Pending", tone: "neutral" },
};

export default async function Applications() {
  const apps = await getApplications();
  return (
    <>
      <PageHeader title="Applications" lede="An application counts as submitted only when the system saw a confirmation." />
      {apps.length === 0 ? <Empty title="No applications yet" action="Applications are prepared in dry-run until you turn on live mode in Settings." /> : (
        <ul className="space-y-3">
          {apps.map((a) => (
            <li key={a.id} className="panel p-4 md:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-serif text-lg mr-auto">{a.title}<span className="block font-sans text-sm text-soft">{a.company}</span></h2>
                <ModeBadge mode={a.mode} /><Badge tone={STATUS[a.status]!.tone}>{STATUS[a.status]!.label}</Badge>
              </div>
              <dl className="grid sm:grid-cols-4 gap-3 mt-4 text-sm">
                <div><dt className="text-soft">Resume</dt><dd>{a.resume ?? "None yet"}</dd></div>
                <div><dt className="text-soft">Relevance</dt><dd className="tabular-nums">{a.relevance ?? "–"}</dd></div>
                <div><dt className="text-soft">Factual confidence</dt><dd className="tabular-nums">{a.factualConfidence != null ? `${a.factualConfidence}%` : "–"}</dd></div>
                <div><dt className="text-soft">When</dt><dd>{a.at ? ago(a.at) : "–"}</dd></div>
              </dl>
              <p className="text-sm mt-3"><span className="text-soft">Confirmation: </span>{a.confirmed && a.evidence ? a.evidence : "No confirmation evidence recorded."}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
