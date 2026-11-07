// Drafts answers to free-text application questions from VERIFIED facts only (the user's resume text and about-me notes).
import { complete, type LlmResult, type LlmOpts } from "../llm.js";
import { scrubForbiddenEmails } from "./identity.js";

export interface EssayInput { question: string; company: string; title: string; description: string; about: string }

const SYSTEM = `You write first-person answers to job-application questions for the candidate described in <about> and <resume>.
Rules:
- Use ONLY facts stated in <about> and <resume>. Never invent metrics, employers, titles, dates, clients, results or motivations.
- Every number, percentage or count in your answer must appear verbatim in <about> or <resume>. If a result has no stated number, describe it without one.
- Do not cite statistics from the candidate's own marketing sites. Do not mention Panda Playbooks.
- About the company, use only what the job description provided states. If it doesn't support a specific claim, talk about the role and the candidate's background instead.
- 90 to 160 words unless the question clearly wants less. Plain, specific, concrete. No flattery, no clichés ("passionate", "thrilled", "dream job").
- Output the answer text only.`;

const numbersIn = (s: string) => (s.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/[,.]$/, ""));

/** Numbers in the draft that do not appear in the verified facts (the model must never invent a metric). */
export function unsupportedNumbers(draft: string, facts: string): string[] {
  return [...new Set(numbersIn(draft))].filter((n) => !facts.includes(n));
}

/** Returns a draft whose every number is traceable to the facts, or null (the question is then left for the user). */
export async function draftEssayAnswer(i: EssayInput, llm: (prompt: string, opts?: LlmOpts) => Promise<LlmResult> = complete): Promise<string | null> {
  const about = scrubForbiddenEmails(i.about); // a resume contact line must never reach the model or an answer
  const base = `<about>\n${about}\n</about>\n\n<job>\nCompany: ${i.company}\nRole: ${i.title}\nDescription:\n${i.description.slice(0, 5000)}\n</job>\n\nQuestion: ${i.question}`;
  let prompt = base;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await llm(prompt, { system: SYSTEM, maxTokens: 3000, model: process.env.ROS_ESSAY_MODEL ?? "claude-haiku-5-5" });
    const t = r.text.trim();
    if (r.source !== "anthropic" || !t) return null;
    if (/@asvagroup\.org/i.test(t)) { prompt = `${base}\n\nDo not include any email address or contact details in the answer.`; continue; }
    const bad = unsupportedNumbers(t, about);
    if (bad.length === 0) return t;
    prompt = `${base}\n\nYour previous draft used numbers that are not in the facts (${bad.join(", ")}). Rewrite it using no numbers other than ones stated in <about> or <resume>.`;
  }
  return null;
}
