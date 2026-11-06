import { Badge, Empty, PageHeader, type Tone } from "@/components/ui";
import { ago, getCompanies } from "@/lib/data";

const BASIS: Record<string, { label: string; tone: Tone; note: string }> = {
  sourced: { label: "Sourced", tone: "good", note: "From a public page we recorded." },
  inference: { label: "Inference", tone: "warn", note: "Our reading of public signals." },
  speculation: { label: "Speculation", tone: "bad", note: "An idea, not company data." },
};

export default async function Companies() {
  const cs = await getCompanies();
  return (
    <>
      <PageHeader title="Company intelligence" lede="Every finding is labelled by how we know it. Speculation is never presented as internal company data." />
      {cs.length === 0 ? <Empty title="No companies researched yet" action="Research runs automatically for high-scoring jobs." /> : (
        <div className="space-y-6">
          {cs.map((c) => (
            <article key={c.id} className="panel p-5">
              <header className="flex items-baseline justify-between gap-3">
                <h2 className="font-serif text-2xl">{c.name}</h2>
                <span className="text-xs text-soft">{c.researchedAt ? `Researched ${ago(c.researchedAt)}` : "Not researched"}</span>
              </header>
              {c.domain && <p className="text-sm text-soft">{c.domain}</p>}
              {c.findings.length === 0 ? <p className="mt-4 text-sm text-soft">No research yet. Ask the Chief of Staff to run it, or wait for the pipeline.</p> : (
                <ul className="mt-4 divide-y divide-mist">
                  {c.findings.map((f, i) => (
                    <li key={i} className="py-3 flex gap-3 items-start">
                      <span title={BASIS[f.basis]!.note}><Badge tone={BASIS[f.basis]!.tone}>{BASIS[f.basis]!.label}</Badge></span>
                      <div><p className="text-sm">{f.text}</p>{f.source && <p className="text-xs text-soft mt-0.5">{f.source}</p>}</div>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
