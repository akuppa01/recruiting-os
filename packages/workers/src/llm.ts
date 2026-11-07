// Shared LLM seam (D-004). Deterministic stub when ANTHROPIC_API_KEY is absent.
export interface LlmOpts { system?: string; maxTokens?: number; json?: boolean; model?: string }
export interface LlmResult { text: string; source: "stub" | "anthropic" }

/** One measured model call. Token counts come from the provider response; costUsd is tokens x a configured price (see cloud/usage.ts). */
export interface LlmUsage { model: string; inputTokens: number; outputTokens: number; measured: boolean }

let usageSink: ((u: LlmUsage) => void) | null = null;
/** Registers a callback that sees every real model call (used for usage metering). Pass null to remove it. */
export function setLlmUsageSink(fn: ((u: LlmUsage) => void) | null) { usageSink = fn; }

export async function complete(prompt: string, opts: LlmOpts = {}): Promise<LlmResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { text: opts.json ? "{}" : "", source: "stub" };
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
  const res = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: [{ role: "user", content: prompt }],
  });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  if (usageSink) {
    const u = (res as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    const measured = typeof u?.input_tokens === "number" && typeof u?.output_tokens === "number";
    // Without a usage block, fall back to a rough length-based estimate and say so (measured=false).
    const inputTokens = measured ? u!.input_tokens! : Math.ceil(((opts.system?.length ?? 0) + prompt.length) / 4);
    const outputTokens = measured ? u!.output_tokens! : Math.ceil(text.length / 4);
    try { usageSink({ model, inputTokens, outputTokens, measured }); } catch { /* metering must never break a call */ }
  }
  return { text, source: "anthropic" };
}
