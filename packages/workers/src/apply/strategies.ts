// Execution strategies beyond the deterministic Playwright flow:
//   SECONDARY  Stagehand (only for unfamiliar fields / changed layouts, behind an interface, lazy-loaded, optional)
//   TERTIARY   configurable agent recovery (default: unsupported)
// LLM use is limited to INTERPRETING A QUESTION as "use saved answer #n" or "needs a human". It never repeats clicks and never sees
// sensitive eligibility questions.
import { DEFAULT_LIMITS, type PipelineLimits } from "@ros/core";
import type { Page } from "playwright";
import { complete as defaultComplete, type LlmOpts, type LlmResult } from "../llm.js";
import { classifyField } from "./fields.js";

export type LlmFn = (prompt: string, opts?: LlmOpts) => Promise<LlmResult>;
export interface SavedRule { match: string; text: string; pick?: string; file?: string }

// ---------------------------------------------------------------- AI budget (per application)
/** Rough cost model: ~4 chars/token; rates are USD per million tokens and configurable. These are ESTIMATES, not provider-billed numbers. */
export function estimateLlmCostUsd(promptChars: number, outChars: number, env: Record<string, string | undefined> = process.env): number {
  const inRate = Number(env.ROS_LLM_USD_PER_MTOK_IN ?? 1), outRate = Number(env.ROS_LLM_USD_PER_MTOK_OUT ?? 5);
  return ((promptChars / 4) * inRate + (outChars / 4) * outRate) / 1_000_000;
}

export class AiBudget {
  calls = 0; spentUsd = 0; fallbackAttempts = 0;
  readonly limitUsd: number; readonly maxAttempts: number;
  constructor(limits: PipelineLimits = DEFAULT_LIMITS, remainingUsd = Infinity) {
    this.limitUsd = Math.min(limits.perApplicationAiUsd, remainingUsd);
    this.maxAttempts = limits.maxFallbackAttempts;
  }
  canAttempt(estimateUsd = 0): boolean { return this.fallbackAttempts < this.maxAttempts && this.spentUsd + estimateUsd <= this.limitUsd; }
  /** Count one fallback attempt (an interpretation or a Stagehand action). */
  attempt(costUsd: number): void { this.fallbackAttempts++; this.calls++; this.spentUsd += costUsd; }
}

// ---------------------------------------------------------------- question interpretation (small model, strict JSON)
export type Interpretation = { action: "use_saved"; ruleIndex: number } | { action: "needs_human"; reason: string };

export async function interpretQuestion(
  q: { question: string; options?: string[] }, rules: SavedRule[],
  o: { budget: AiBudget; llm?: LlmFn; model?: string },
): Promise<Interpretation> {
  const usable = rules.map((r, i) => ({ r, i })).filter(({ r }) => !r.file);
  if (!q.question.trim() || usable.length === 0) return { action: "needs_human", reason: "no saved answers to map to" };
  // Defense in depth: eligibility/EEO/legal questions are never sent to a model.
  if (classifyField(q.question).kind === "sensitive") return { action: "needs_human", reason: "sensitive question" };
  const list = usable.map(({ r, i }) => `[${i}] question about /${r.match}/ -> saved answer "${r.text}"`).join("\n");
  const prompt = `A job application form asks: "${q.question}"${q.options?.length ? `\nChoices: ${q.options.slice(0, 12).join(" | ")}` : ""}
Saved answers (the applicant's own, verified):
${list}
Decide whether exactly one saved answer correctly answers this question. If none clearly does, answer needsHuman.
Reply with JSON only: {"ruleIndex": <number or null>, "needsHuman": <true|false>}`;
  const est = estimateLlmCostUsd(prompt.length, 60);
  if (!o.budget.canAttempt(est)) return { action: "needs_human", reason: "AI budget or fallback attempts exhausted" };
  let out: LlmResult;
  try { out = await (o.llm ?? defaultComplete)(prompt, { json: true, maxTokens: 400, model: o.model ?? process.env.ROS_FORM_MODEL ?? "claude-haiku-5-5" }); }
  catch (e) { o.budget.attempt(est); return { action: "needs_human", reason: `model error: ${e instanceof Error ? e.message : "unknown"}` }; }
  o.budget.attempt(estimateLlmCostUsd(prompt.length, out.text.length));
  if (out.source !== "anthropic" && !o.llm) return { action: "needs_human", reason: "no model configured" };
  try {
    const m = out.text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : out.text) as { ruleIndex?: number | null; needsHuman?: boolean };
    if (j.needsHuman || typeof j.ruleIndex !== "number" || !usable.some(({ i }) => i === j.ruleIndex)) return { action: "needs_human", reason: "model found no matching saved answer" };
    return { action: "use_saved", ruleIndex: j.ruleIndex };
  } catch { return { action: "needs_human", reason: "model returned invalid JSON" }; }
}

// ---------------------------------------------------------------- Stagehand (secondary)
export interface StagehandLike { act(instruction: string): Promise<unknown>; close?(): Promise<void> }
export type StagehandResult = { ok: true; sh: StagehandLike } | { ok: false; reason: string };
/** Creates a Stagehand bound to the given page. Injectable so tests and callers can supply their own. */
export type StagehandProvider = (page: Page) => Promise<StagehandResult>;

/**
 * Lazy loader for @browserbasehq/stagehand. Returns a clear 'not installed' result when the package is absent (it is NOT a dependency).
 * UNVERIFIED against the real package: Stagehand drives its own browser session, so a caller that wants to share this page should
 * inject a StagehandProvider instead.
 */
export const loadStagehand: StagehandProvider = async () => {
  const name = "@browserbasehq/stagehand";
  try {
    const mod: any = await import(/* @vite-ignore */ name);
    const Ctor = mod.Stagehand ?? mod.default;
    if (!Ctor) return { ok: false, reason: `${name} is installed but exports no Stagehand class` };
    const sh = new Ctor({ env: "LOCAL", verbose: 0 });
    await sh.init?.();
    return { ok: true, sh: { act: (i: string) => sh.page.act(i), close: () => sh.close?.() } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: /Cannot find (module|package)|ERR_MODULE_NOT_FOUND|Failed to resolve|Failed to load url|Does the file exist/i.test(msg) ? `${name} is not installed` : `${name} failed to start: ${msg}` };
  }
};

/** Flat estimate per Stagehand action (it makes one or more model calls internally). Configurable. */
export const stagehandActCostUsd = (env: Record<string, string | undefined> = process.env) => Number(env.ROS_STAGEHAND_ACT_USD ?? 0.01);

// ---------------------------------------------------------------- tertiary: agent recovery
export interface AgentRecovery { recover(page: Page, info: { reason: string; question?: string }): Promise<{ ok: boolean; reason: string }> }
export const unsupportedAgent: AgentRecovery = { async recover() { return { ok: false, reason: "agent recovery is not configured" }; } };
