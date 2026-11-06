import type { EvidenceItem } from "@ros/core";

const STOP = new Set(["the","a","an","and","or","of","to","in","on","for","with","by","at","from","as","across","into","using","via","over","led","built","drove","managed","owned","created","launched","delivered","developed","designed","worked","improved","reduced","increased"]);

const norm = (s: string) => s.toLowerCase().replace(/,/g, "").replace(/\s+/g, "");
const sourceCorpus = (e: EvidenceItem) => [e.statement, ...e.metrics, e.employer, e.role, e.dates, ...e.tags].join(" ");

export function numericTokens(s: string): string[] {
  return (s.match(/\$?\d[\d,]*(?:\.\d+)?\s?(?:%|k\b|m\b|mm\b|x\b|\+)?/gi) ?? []).map(norm).filter(Boolean);
}

export interface VerifyResult { ok: boolean; reasons: string[] }

/** A bullet is verified only if every number, every proper noun, and most words trace to its source EvidenceItem. */
export function verifyBullet(text: string, source: EvidenceItem): VerifyResult {
  const reasons: string[] = [];
  const corpus = sourceCorpus(source);
  const corpusNums = numericTokens(corpus);
  for (const n of numericTokens(text)) {
    const ok = corpusNums.includes(n);
    if (!ok) reasons.push(`number "${n}" not in source evidence`);
  }
  const lowerCorpus = corpus.toLowerCase();
  const toks = text.match(/[A-Za-z0-9][A-Za-z0-9&.'/-]*/g) ?? [];
  toks.forEach((t, i) => {
    if (/^[A-Z]/.test(t) && i > 0 && !STOP.has(t.toLowerCase()) && !/^\d/.test(t)) {
      if (!lowerCorpus.includes(t.toLowerCase())) reasons.push(`proper noun/title "${t}" not in source evidence`);
    }
  });
  const srcWords = new Set((source.statement.toLowerCase().match(/[a-z0-9]+/g) ?? []));
  const bw = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w));
  const contained = bw.length ? bw.filter((w) => srcWords.has(w) || lowerCorpus.includes(w)).length / bw.length : 1;
  if (contained < 0.6) reasons.push(`only ${(contained * 100).toFixed(0)}% of words trace to the source statement`);
  return { ok: reasons.length === 0, reasons };
}

export interface ResumeBullet { evidenceId: string; text: string; rephrased: boolean }
export interface ResumeSection { employer: string; role: string; dates: string; bullets: ResumeBullet[] }
export interface ResumeContent {
  archetype: string; headline: string; name: string; contact: string[]; education: string[]; sections: ResumeSection[];
}

/** Re-verify an entire resume object against the evidence bank (headers must equal source; bullets must verify). */
export function verifyResume(content: ResumeContent, evidence: EvidenceItem[]): { ok: boolean; failures: Array<{ evidenceId: string; text: string; reasons: string[] }> } {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const failures: Array<{ evidenceId: string; text: string; reasons: string[] }> = [];
  for (const s of content.sections) {
    for (const b of s.bullets) {
      const src = byId.get(b.evidenceId);
      if (!src) { failures.push({ evidenceId: b.evidenceId, text: b.text, reasons: ["unknown evidenceId"] }); continue; }
      const reasons: string[] = [];
      if (src.employer !== s.employer || src.role !== s.role || src.dates !== s.dates) reasons.push("employer/role/dates differ from source evidence");
      if (!b.rephrased && b.text !== src.statement) reasons.push("verbatim bullet differs from source");
      if (b.rephrased) reasons.push(...verifyBullet(b.text, src).reasons);
      if (reasons.length) failures.push({ evidenceId: b.evidenceId, text: b.text, reasons });
    }
  }
  return { ok: failures.length === 0, failures };
}
