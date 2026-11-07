// Usage metering written to public.usage_events. Token counts are MEASURED from the provider response when present;
// dollar cost is tokens x a configured price (ROS_LLM_USD_PER_MTOK_IN/OUT, defaults are assumptions) and is labelled as such.
import type { Ctx } from "@ros/core";
import type { LlmUsage } from "../llm.js";

export interface UsageRow { metric: string; quantity: number; costUsd?: number; model?: string; ref?: string }
export interface UsageRecorder { record(ctx: Ctx, rows: UsageRow[]): Promise<void> }

export class InMemoryUsageRecorder implements UsageRecorder {
  rows: Array<UsageRow & { ctx: Ctx }> = [];
  async record(ctx: Ctx, rows: UsageRow[]) { for (const r of rows) this.rows.push({ ...r, ctx }); }
}

export interface SbInsertLike { from(table: string): any }
export class SupabaseUsageRecorder implements UsageRecorder {
  constructor(private sb: SbInsertLike) {}
  async record(ctx: Ctx, rows: UsageRow[]) {
    if (!rows.length) return;
    const { error } = await this.sb.from("usage_events").insert(rows.map((r) => ({
      tenant_id: ctx.tenantId, user_id: ctx.userId, metric: r.metric, quantity: r.quantity,
      cost_usd: r.costUsd ?? 0, model: r.model ?? null, ref: r.ref ?? null,
    })));
    if (error) throw new Error(`usage_events insert: ${error.message}`);
  }
}

export function llmCostUsd(u: Pick<LlmUsage, "inputTokens" | "outputTokens">, env: Record<string, string | undefined> = process.env): number {
  const inRate = Number(env.ROS_LLM_USD_PER_MTOK_IN ?? 1), outRate = Number(env.ROS_LLM_USD_PER_MTOK_OUT ?? 5);
  return (u.inputTokens * inRate + u.outputTokens * outRate) / 1_000_000;
}

/** Accumulates model usage for one unit of work (one apply task). */
export class UsageMeter {
  calls = 0; inputTokens = 0; outputTokens = 0; costUsd = 0; allMeasured = true; private models = new Set<string>();
  readonly sink = (u: LlmUsage) => {
    this.calls++; this.inputTokens += u.inputTokens; this.outputTokens += u.outputTokens;
    this.costUsd += llmCostUsd(u); if (!u.measured) this.allMeasured = false; this.models.add(u.model);
  };
  get model(): string | undefined { return [...this.models].join(",") || undefined; }
  /** ref says exactly what kind of number this is, so the dashboard can label measured vs estimated. */
  get ref(): string { return this.allMeasured ? "tokens measured; price assumed" : "estimate"; }
  toRows(): UsageRow[] {
    if (this.calls === 0) return [];
    return [
      { metric: "llm.calls", quantity: this.calls, costUsd: this.costUsd, model: this.model, ref: this.ref },
      { metric: "llm.input_tokens", quantity: this.inputTokens, model: this.model, ref: this.allMeasured ? "measured" : "estimate" },
      { metric: "llm.output_tokens", quantity: this.outputTokens, model: this.model, ref: this.allMeasured ? "measured" : "estimate" },
    ];
  }
}
