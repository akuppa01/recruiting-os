// Shared LLM seam (D-004). Deterministic stub when ANTHROPIC_API_KEY is absent.
export interface LlmOpts { system?: string; maxTokens?: number; json?: boolean; model?: string }
export interface LlmResult { text: string; source: "stub" | "anthropic" }

export async function complete(prompt: string, opts: LlmOpts = {}): Promise<LlmResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { text: opts.json ? "{}" : "", source: "stub" };
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });
  const res = await client.messages.create({
    model: opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: [{ role: "user", content: prompt }],
  });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return { text, source: "anthropic" };
}
