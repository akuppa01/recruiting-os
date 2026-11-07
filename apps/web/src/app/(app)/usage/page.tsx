import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { UsagePanel } from "@/components/usage-panel";
import { getUsage } from "@/lib/data";

export default async function Usage() {
  const usage = await getUsage();
  return (
    <>
      <PageHeader variant="apple" title="Usage and limits" lede="What the automation costs: AI calls, application attempts and browser runs. Measured values come from real responses; estimates are labelled." right={<Link href="/settings" className="btn-quiet rounded-xl shrink-0">Settings</Link>} />
      <UsagePanel usage={usage} />
    </>
  );
}
