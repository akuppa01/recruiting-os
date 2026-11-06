import type { Ctx, EvidenceItem, ResumeVersionRow, Store } from "@ros/core";
import { loadEvidence } from "./evidence.js";
import { renderResumePdf } from "./pdf.js";
import { tailorResume } from "./tailor.js";

export * from "./evidence.js";
export * from "./archetypes.js";
export * from "./verify.js";
export * from "./tailor.js";
export * from "./pdf.js";

export interface ResumeStageOpts { evidenceDir?: string; minFactualConfidence?: number; uploadPdf?: (path: string, pdf: Buffer) => Promise<void> }

/**
 * jobId -> ResumeVersion persisted. Raises exceptions (no resume) when evidence is missing or confidence is low.
 * Returns the saved row + PDF, or null when blocked.
 */
export async function runResumeStage(store: Store, ctx: Ctx, jobId: string, opts: ResumeStageOpts = {}): Promise<{ row: ResumeVersionRow; pdf: Buffer } | null> {
  const job = await store.getJob(ctx, jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const bank = loadEvidence(opts.evidenceDir ?? "resumes/evidence");
  if (!bank.items.length) {
    await store.raiseException(ctx, { ctx, type: "missing_profile_field", entityType: "job", entityId: jobId, detail: "Evidence bank is empty. Add verified evidence to resumes/evidence/private/ (see resumes/evidence/README.md)." });
    await store.logEvent(ctx, "resume.blocked", "job", jobId, { reason: "empty_evidence" });
    return null;
  }
  const t = tailorResume(job.normalized, bank.items, undefined, { profile: bank.profile });
  const min = opts.minFactualConfidence ?? 0.95;
  if (!t.verification.ok || t.factualConfidence < min) {
    await store.raiseException(ctx, { ctx, type: "low_factual_confidence", entityType: "job", entityId: jobId, detail: `Resume failed verification: ${JSON.stringify(t.verification.failures).slice(0, 500)}` });
    await store.logEvent(ctx, "resume.blocked", "job", jobId, { reason: "low_factual_confidence", confidence: t.factualConfidence });
    return null;
  }
  const pdf = await renderResumePdf(t.contentJson);
  const storagePath = `${ctx.tenantId}/${ctx.userId}/resumes/${jobId}-${t.archetype}.pdf`;
  let stored: string | null = null;
  if (opts.uploadPdf) { await opts.uploadPdf(storagePath, pdf); stored = storagePath; }
  const row = await store.saveResumeVersion(ctx, {
    ctx, jobId, archetype: t.archetype, evidenceIds: t.selectedEvidenceIds, relevanceScore: t.relevanceScore,
    factualConfidence: t.factualConfidence, storagePath: stored, contentJson: t.contentJson,
  });
  await store.logEvent(ctx, "resume.generated", "job", jobId, { resumeVersionId: row.id, archetype: t.archetype, relevance: t.relevanceScore, confidence: t.factualConfidence });
  return { row, pdf };
}
export type { EvidenceItem };
