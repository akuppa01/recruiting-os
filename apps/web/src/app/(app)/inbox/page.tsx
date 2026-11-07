import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { ExceptionActions } from "@/components/exception-actions";
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
      <AutoRefresh />
      <PageHeader variant="apple" title="Inbox" lede="Only tasks the system genuinely can't do itself land here. Retry gives the go-ahead for another attempt; skip archives the job." />
      <section aria-labelledby="open" className="mb-8">
        <h2 id="open" className="text-base font-semibold mb-3">Needs you{open.length ? ` (${open.length})` : ""}</h2>
        {open.length === 0 ? <Empty title="You're clear" action="The system will add a task here if it hits a CAPTCHA, a sign-in or a sensitive question." /> : (
          <ul className="space-y-3">
            {open.map((e) => (
              <li key={e.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3 flex-wrap">
                    <Badge tone="warn">{TYPE_LABEL[e.type] ?? "Other"}</Badge>
                    <span className="text-xs text-soft ml-auto">{ago(e.createdAt)}</span>
                  </div>
                  <p className="font-medium mt-2">{e.entity}</p>
                  <p className="text-sm text-soft mt-0.5 break-words">{e.detail}</p>
                  <div className="mt-3">
                    <ExceptionActions id={e.id} canRetry={!!e.canRetry} canSkip={!!e.canSkip} retryBlockedReason={e.retryBlockedReason ?? null} />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="notif" className="mb-8">
        <h2 id="notif" className="text-base font-semibold mb-3">Notifications</h2>
        {ups.length === 0 ? <Empty title="No notifications" /> : (
          <Card>
            <ul className="divide-y divide-mist">
              {ups.map((u) => (
                <li key={u.id} className="p-4 flex flex-wrap gap-x-3 gap-y-1 items-center">
                  <Badge>{u.kind}</Badge><span className="text-sm min-w-0 break-words">{u.text}</span><span className="ml-auto text-xs text-soft">{ago(u.at)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
      {done.length > 0 && (
        <section aria-labelledby="done">
          <h2 id="done" className="text-base font-semibold mb-3">Resolved</h2>
          <Card><ul className="divide-y divide-mist">{done.map((e) => (<li key={e.id} className="p-4 text-sm text-soft break-words">{e.entity}: {e.detail}</li>))}</ul></Card>
        </section>
      )}
    </>
  );
}
