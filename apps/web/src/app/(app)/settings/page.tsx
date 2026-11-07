import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { PolicyForm } from "@/components/policy-form";
import { PrefsForm } from "@/components/prefs-form";
import { PipelineHealth } from "@/components/pipeline-health";
import { getPipelineHealth } from "@/lib/data";
import { getIntegrations } from "@/lib/integrations";

export default async function Settings() {
  const items = getIntegrations();
  const health = await getPipelineHealth();
  return (
    <>
      <PageHeader variant="apple" title="Integrations and settings" right={<Link href="/usage" className="btn-quiet rounded-xl shrink-0">Usage and limits</Link>} />
      <PipelineHealth health={health} />
      <section aria-labelledby="int" className="mb-10">
        <h2 id="int" className="text-base font-semibold mb-1">Integrations</h2>
        <p className="text-sm text-soft mb-4">"Configured" means credentials are present on the server. It does not mean the connection has been tested.</p>
        <ul className="grid md:grid-cols-2 gap-4">
          {items.map((i) => (
            <li key={i.id}><Card className="p-4">
              <div className="flex items-center justify-between gap-2"><h3 className="font-medium">{i.name}</h3><Badge tone={i.configured ? "good" : "neutral"}>{i.configured ? "Configured" : "Not connected"}</Badge></div>
              <p className="text-sm text-soft mt-1">{i.purpose}</p>
              {!i.configured && (<><p className="text-sm mt-2">{i.steps}</p><a href={i.setupUrl} target="_blank" rel="noreferrer" className="btn-quiet mt-3 inline-flex">Open {i.name} setup</a></>)}
            </Card></li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="pol" className="mb-10"><h2 id="pol" className="sr-only">Automation policy</h2><PolicyForm /></section>
      <section aria-labelledby="pre"><h2 id="pre" className="sr-only">Preferences</h2><PrefsForm /></section>
    </>
  );
}
