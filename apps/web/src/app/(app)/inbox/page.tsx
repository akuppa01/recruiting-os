import { Badge, Empty, PageHeader } from "@/components/ui";
import { ResolveButton } from "@/components/resolve-button";
import { ago, getExceptions, getUpdates } from "@/lib/data";

const TYPE_LABEL: Record<string, string> = {
  captcha: "CAPTCHA", auth_required: "Sign-in needed", sensitive_eligibility_question: "Eligibility question",
  platform_restricts_automation: "Automation not allowed", missing_profile_field: "Missing profile detail",
  low_factual_confidence: "Resume needs checking", submission_unverified: "Submission not confirmed",
  integration_not_connected: "Not connected", other: "Other",
};

export default async function Inbox() {
  const [ex, ups] = await Promise.all([getExceptions(), getUpdates()]);
  const open = ex.filter((e) => !e.resolved), done = ex.filter((e) => e.resolved);
  return (
    <>
      <PageHeader title="Notifications and exceptions" lede="Only tasks the system genuinely can't do itself land here." />
      <section aria-labelledby="open" className="mb-8">
        <h2 id="open" className="font-serif text-xl mb-3">Needs you</h2>
        {open.length === 0 ? <Empty title="You're clear" action="The system will add a task here if it hits a CAPTCHA, a sign-in or a sensitive question." /> : (
          <ul className="panel divide-y divide-mist">
            {open.map((e) => (
              <li key={e.id} className="p-4 flex flex-wrap items-center gap-3">
                <Badge tone="warn">{TYPE_LABEL[e.type]}</Badge>
                <div className="min-w-0 flex-1"><p className="font-medium">{e.entity}</p><p className="text-sm text-soft">{e.detail}</p></div>
                <span className="text-xs text-soft">{ago(e.createdAt)}</span>
                <ResolveButton id={e.id} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="notif" className="mb-8">
        <h2 id="notif" className="font-serif text-xl mb-3">Notifications</h2>
        {ups.length === 0 ? <Empty title="No notifications" /> : (
          <ul className="panel divide-y divide-mist">
            {ups.map((u) => (<li key={u.id} className="p-4 flex gap-3 items-center"><Badge>{u.kind}</Badge><span className="text-sm">{u.text}</span><span className="ml-auto text-xs text-soft">{ago(u.at)}</span></li>))}
          </ul>
        )}
      </section>
      {done.length > 0 && (
        <section aria-labelledby="done">
          <h2 id="done" className="font-serif text-xl mb-3">Resolved</h2>
          <ul className="panel divide-y divide-mist">{done.map((e) => (<li key={e.id} className="p-4 text-sm text-soft">{e.entity}: {e.detail}</li>))}</ul>
        </section>
      )}
    </>
  );
}
