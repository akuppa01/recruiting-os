import { createHash } from "node:crypto";
import type { Ctx, NormalizedJob, ScoreBreakdown, IngestRequest } from "@ros/core";
import { NormalizedJob as NJ } from "@ros/core";
import type { PipelineStages } from "../src/pipeline/types.js";

export const ctx: Ctx = { tenantId: "t1", userId: "u1" };
export const noSleep = async () => {};

/** Test-only stub normalizer (real one is Agent B's). */
export async function stubNormalize(req: IngestRequest): Promise<NormalizedJob> {
  const url = req.url ?? null;
  const gh = url?.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  const text = req.text ?? "";
  const title = gh ? "Product Manager Intern" : (text.match(/^Title:\s*(.+)$/m)?.[1] ?? "Unknown");
  const company = gh ? gh[1]! : (text.match(/^Company:\s*(.+)$/m)?.[1] ?? "Unknown");
  const dedupeKey = gh ? `greenhouse:${gh[2]}` : createHash("sha256").update(`${company}|${title}`.toLowerCase()).digest("hex");
  return NJ.parse({ title, company, description: text, applyUrl: url, sourceUrl: url, atsKind: gh ? "greenhouse" : "unknown", atsJobId: gh?.[2] ?? null, roleCategory: "product_management", isInternship: true, dedupeKey });
}

export function stubScorer(total: number, decision: ScoreBreakdown["decision"] = "qualify", hardRejects: string[] = []): PipelineStages["score"] {
  return async (store, c, jobId) => {
    const score: ScoreBreakdown = { total, roleFit: total, comp: total, conversion: total, responsibility: total, flexibility: total, upside: total, entrepreneurialCompat: total, hardRejects, rationale: "stub", decision };
    await store.setJobStage(c, jobId, "scored", score);
  };
}
