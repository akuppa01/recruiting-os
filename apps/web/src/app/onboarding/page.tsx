import { Onboarding } from "@/components/onboarding";
import { getIntegrations } from "@/lib/integrations";

export const dynamic = "force-dynamic";

export default function OnboardingPage() {
  return (
    <main className="px-4 md:px-10 py-8 md:py-12">
      <h1 className="page-title mb-1">Set up Recruiting OS</h1>
      <p className="text-soft mb-8 max-w-prose">Four short steps. Everything starts in dry-run, so nothing is sent until you say so.</p>
      <Onboarding integrations={getIntegrations()} />
    </main>
  );
}
