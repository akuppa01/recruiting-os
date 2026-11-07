import { Badge, Card, Meter, usd } from "@/components/ui";
import type { SpendView, UsageView } from "@/lib/data";

const n0 = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (n: number | null) => (n == null ? "–" : `${n}%`);

function Tag({ kind }: { kind: "measured" | "estimate" }) {
  return <Badge tone={kind === "measured" ? "good" : "warn"}>{kind === "measured" ? "Measured" : "Estimate"}</Badge>;
}

function Spend({ title, s, measuredUsd, estimatedUsd }: { title: string; s: SpendView; measuredUsd: number; estimatedUsd: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-sm tabular-nums">{usd(s.spentUsd)} <span className="text-soft">of {usd(s.limitUsd)}</span></span>
      </div>
      <Meter pct={s.pct} level={s.level} label={`${title} AI spend against its limit`} />
      <p className="text-xs text-soft mt-1.5">
        {s.level === "over" ? "Limit reached: AI steps are skipped until it resets. " : s.level === "warn" ? "Close to the limit. " : ""}
        {usd(measuredUsd)} measured{estimatedUsd > 0 ? `, ${usd(estimatedUsd)} estimated` : ""}.
      </p>
    </div>
  );
}

/** Usage and limits. Measured values come from real model responses; anything tagged Estimate is derived and never added into Measured. */
export function UsagePanel({ usage }: { usage: UsageView }) {
  const { summary: u, spend, limits, applications: a, browser: b, n8n } = usage;
  const hasEstimates = u.estimated.calls > 0 || u.estimated.costUsd > 0;
  return (
    <div className="space-y-4">
      {!usage.hasData && (
        <Card className="p-4"><p className="text-sm text-soft">Nothing has been recorded yet. AI calls, application attempts and browser runs appear here as they happen. The n8n figure below is always an estimate.</p></Card>
      )}

      <Card className="p-4 md:p-5">
        <h2 className="text-base font-semibold mb-3">AI spend against limits</h2>
        <div className="grid md:grid-cols-2 gap-5">
          <Spend title="Today" s={spend.daily} measuredUsd={u.today.measuredUsd} estimatedUsd={u.today.estimatedUsd} />
          <Spend title="This month" s={spend.monthly} measuredUsd={u.month.measuredUsd} estimatedUsd={u.month.estimatedUsd} />
        </div>
        <p className="text-xs text-soft mt-4">
          Other limits: {usd(limits.perApplicationAiUsd)} per application, {limits.maxFallbackAttempts} fallback attempts, {limits.maxBrowserSeconds}s browser time per application.
          Days and months are in UTC.
        </p>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-4 md:p-5">
          <h2 className="text-base font-semibold mb-3">AI model calls</h2>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
            <dt className="flex items-center gap-2">Calls <Tag kind="measured" /></dt><dd className="tabular-nums">{n0(u.measured.calls)}</dd>
            <dt className="text-soft pl-1">Input tokens</dt><dd className="tabular-nums">{n0(u.measured.inputTokens)}</dd>
            <dt className="text-soft pl-1">Output tokens</dt><dd className="tabular-nums">{n0(u.measured.outputTokens)}</dd>
            <dt className="text-soft pl-1">Cost</dt><dd className="tabular-nums">{usd(u.measured.costUsd)}</dd>
            {hasEstimates && (
              <>
                <dt className="flex items-center gap-2 pt-2">Calls <Tag kind="estimate" /></dt><dd className="tabular-nums pt-2">{n0(u.estimated.calls)}</dd>
                <dt className="text-soft pl-1">Input tokens</dt><dd className="tabular-nums">{n0(u.estimated.inputTokens)}</dd>
                <dt className="text-soft pl-1">Output tokens</dt><dd className="tabular-nums">{n0(u.estimated.outputTokens)}</dd>
                <dt className="text-soft pl-1">Cost</dt><dd className="tabular-nums">{usd(u.estimated.costUsd)}</dd>
              </>
            )}
          </dl>
          {!hasEstimates && u.measured.calls === 0 && <p className="text-xs text-soft mt-3">No model call has been recorded. Deterministic steps use no model.</p>}
          {hasEstimates && <p className="text-xs text-soft mt-3">Estimates are used when a provider response had no token counts.</p>}
        </Card>

        <Card className="p-4 md:p-5">
          <h2 className="text-base font-semibold mb-3">Applications and browser runs</h2>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
            <dt>Processed</dt><dd className="tabular-nums">{a.processed}</dd>
            <dt className="text-soft pl-1">Submitted and confirmed</dt><dd className="tabular-nums">{a.confirmed}</dd>
            <dt className="text-soft pl-1">Sent, not confirmed</dt><dd className="tabular-nums">{a.unverified}</dd>
            <dt className="text-soft pl-1">Failed</dt><dd className="tabular-nums">{a.failed}</dd>
            <dt className="text-soft pl-1">Confirmed rate</dt><dd className="tabular-nums">{pct(a.successRate)}</dd>
            <dt className="pt-2">Browser runs</dt><dd className="tabular-nums pt-2">{b.runs}</dd>
            <dt className="text-soft pl-1">Succeeded</dt><dd className="tabular-nums">{b.succeeded}</dd>
            <dt className="text-soft pl-1">Failed</dt><dd className="tabular-nums">{b.failed}</dd>
          </dl>
          <p className="text-xs text-soft mt-3">Processed counts every application row except pending ones, including dry runs. Dry runs are not counted as attempts for the rate.</p>
        </Card>
      </div>

      <Card className="p-4 md:p-5">
        <h2 className="text-base font-semibold mb-1 flex items-center gap-2">n8n executions <Tag kind="estimate" /></h2>
        <p className="text-sm text-soft mb-3">n8n doesn&apos;t report usage to this app. This is computed from the workflow schedules, not read from n8n.</p>
        <ul className="text-sm divide-y divide-mist">
          {n8n.workflows.map((w) => (<li key={w.name} className="py-1.5 flex justify-between gap-3"><span>{w.name}</span><span className="tabular-nums text-soft">{w.runsPerDay}/day</span></li>))}
        </ul>
        <p className="text-sm mt-3">About <span className="font-semibold tabular-nums">{n8n.perDay}</span> per day, <span className="font-semibold tabular-nums">{n8n.perMonth}</span> per 30 days.</p>
      </Card>
    </div>
  );
}
