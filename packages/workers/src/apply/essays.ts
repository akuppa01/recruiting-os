// Drafts answers to free-text application questions from VERIFIED facts only (the user's resume text and about-me notes).
import { complete } from "../llm.js";

export interface EssayInput { question: string; company: string; title: string; description: string; about: string }

const SYSTEM = `You write first-person answers to job-application questions for the candidate described in <about> and <resume>.
Rules:
- Use ONLY facts stated in <about> and <resume>. Never invent metrics, employers, titles, dates, clients, results or motivations.
- Do not cite statistics from the candidate's own marketing sites. Do not mention Panda Playbooks.
- About the company, use only what the job description provided states. If it doesn't support a specific claim, talk about the role and the candidate's background instead.
- 90 to 160 words unless the question clearly wants less. Plain, specific, concrete. No flattery, no clichés ("passionate", "thrilled", "dream job").
- Output the answer text only.`;

export async function draftEssayAnswer(i: EssayInput): Promise<string | null> {
  const prompt = `<about>\n${i.about}\n</about>\n\n<job>\nCompany: ${i.company}\nRole: ${i.title}\nDescription:\n${i.description.slice(0, 5000)}\n</job>\n\nQuestion: ${i.question}`;
  const r = await complete(prompt, { system: SYSTEM, maxTokens: 3000, model: process.env.ROS_ESSAY_MODEL ?? "claude-haiku-5-5" });
  const t = r.text.trim();
  return r.source === "anthropic" && t ? t : null;
}
