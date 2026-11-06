import type { EvidenceItem } from "@ros/core";

export interface DraftInput {
  step: number;                       // 0 = intro, 1..n follow-ups
  contactName: string;
  contactTitle?: string | null;
  company: string;
  jobTitle: string;
  jobDescription?: string;
  candidateName: string;
  candidateIntro: string;             // supplied by the candidate, e.g. "an MBA student at Carnegie Mellon Tepper"
  evidence: EvidenceItem[];           // REQUIRED: verified bank; statements are used verbatim
  proofUrl?: string | null;           // only a real, verified URL; never invented
  postalAddress?: string;
}
export interface Draft { subject: string; body: string; evidenceIds: string[] }

export const OPT_OUT_LINE = `If you'd rather not hear from me, just reply "unsubscribe" and I won't contact you again.`;

export function pickEvidence(evidence: EvidenceItem[], jobTitle: string, description = "", n = 2): EvidenceItem[] {
  const hay = `${jobTitle} ${description}`.toLowerCase();
  const scored = evidence.map((e, i) => ({ e, i, s: e.tags.filter((t) => hay.includes(t.toLowerCase())).length }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, n).map((x) => x.e);
}

/** Drafts use ONLY evidence statements verbatim. No invented accomplishments, numbers or claims. */
export function draftEmail(i: DraftInput): Draft {
  if (!i.evidence.length) throw new Error("draftEmail requires a non-empty verified EvidenceItem[]; refusing to write unsupported claims");
  const first = i.contactName.split(/\s+/)[0] ?? i.contactName;
  const picked = pickEvidence(i.evidence, i.jobTitle, i.jobDescription);
  const facts = picked.map((e) => `- ${e.statement}`).join("\n");
  const sig = `${i.candidateName}${i.postalAddress ? `\n${i.postalAddress}` : ""}`;
  const proof = i.proofUrl ? `\n\nI also put together a short public-source look at ${i.company}: ${i.proofUrl}` : "";
  let subject: string, body: string;
  if (i.step === 0) {
    subject = `${i.jobTitle} at ${i.company}: ${i.candidateName}`;
    body = `Hi ${first},\n\nI'm ${i.candidateName}, ${i.candidateIntro}. I'm interested in the ${i.jobTitle} role at ${i.company} and wanted to reach out directly.\n\nRelevant background:\n${facts}${proof}\n\nWould you be open to a brief conversation about the team?\n\nThanks,\n${sig}\n\n${OPT_OUT_LINE}`;
  } else if (i.step === 1) {
    subject = `Re: ${i.jobTitle} at ${i.company}: ${i.candidateName}`;
    body = `Hi ${first},\n\nFollowing up on my note below about the ${i.jobTitle} role. Happy to share more context or a resume if useful.\n\nThanks,\n${sig}\n\n${OPT_OUT_LINE}`;
  } else {
    subject = `Re: ${i.jobTitle} at ${i.company}: ${i.candidateName}`;
    body = `Hi ${first},\n\nOne last note on the ${i.jobTitle} role at ${i.company}. If it isn't the right time or the right person, no problem at all.\n\nThanks,\n${sig}\n\n${OPT_OUT_LINE}`;
  }
  return { subject, body, evidenceIds: i.step === 0 ? picked.map((e) => e.id) : [] };
}
