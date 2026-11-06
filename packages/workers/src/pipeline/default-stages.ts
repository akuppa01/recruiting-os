// Wires the real stage implementations from Agents B and C into the orchestrator's DI registry.
import { normalizeJob, rawFromRequest } from "../normalize/index.js";
import { runScoreStage } from "../stages/index.js";
import { runResearchStage, type ResearchDeps } from "../research/index.js";
import { runResumeStage, type ResumeStageOpts } from "../resume/index.js";
import type { ApplyFn, PipelineStages, StageFn } from "./types.js";

export interface DefaultStageDeps {
  research?: ResearchDeps; resume?: ResumeStageOpts;
  apply?: ApplyFn;               // B's ATS adapter dispatcher when available; absent => apply stage logged as skipped
  contacts?: StageFn; proofOfWork?: StageFn; outreach?: StageFn; followups?: StageFn; coverLetter?: StageFn;
}

export function createDefaultStages(d: DefaultStageDeps = {}): PipelineStages {
  return {
    normalize: async (req) => normalizeJob(rawFromRequest(req)),
    score: runScoreStage,
    research: (s, c, id) => runResearchStage(s, c, id, d.research),
    resume: async (s, c, id) => { await runResumeStage(s, c, id, d.resume); },
    coverLetter: d.coverLetter, apply: d.apply, contacts: d.contacts, proofOfWork: d.proofOfWork, outreach: d.outreach, followups: d.followups,
  };
}
