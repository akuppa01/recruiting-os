import { Badge, Empty, PageHeader } from "@/components/ui";
import { getProofs } from "@/lib/data";

export default async function Proof() {
  const ps = await getProofs();
  return (
    <>
      <PageHeader title="Proof-of-work assets" lede="Company-specific dashboards and walkthrough scripts, built from public information only." />
      {ps.length === 0 ? <Empty title="No assets yet" action="Assets are generated for jobs scoring 80 or higher." /> : (
        <ul className="grid md:grid-cols-2 gap-4">
          {ps.map((p) => (
            <li key={p.id} className="panel p-5">
              <p className="text-sm text-soft">{p.company}</p>
              <h2 className="font-serif text-xl mb-3">{p.title}</h2>
              <div className="flex flex-wrap gap-2 items-center">
                <Badge tone={p.status === "preview_ready" ? "good" : "neutral"}>{p.status === "preview_ready" ? "Preview ready" : "Draft"}</Badge>
                <Badge>{p.loomScript ? "Walkthrough script ready" : "No script yet"}</Badge>
              </div>
              <p className="text-sm text-soft mt-3">{p.previewUrl ? p.previewUrl : "No shareable link has been deployed."}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
