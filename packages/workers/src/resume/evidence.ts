import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EvidenceItem } from "@ros/core";

export const CandidateProfile = z.object({
  name: z.string(), email: z.string().email(), phone: z.string().optional(), linkedin: z.string().optional(),
  location: z.string().optional(), education: z.array(z.string()).default([]),
  // application-form data (repetitive fields)
  website: z.string().optional(), workAuthorization: z.string().optional(), pronouns: z.string().optional(),
  eligibility: z.object({ usCitizen: z.boolean().optional(), authorizedToWorkUS: z.boolean().optional(), requiresSponsorship: z.boolean().optional(), veteran: z.boolean().optional(), disability: z.boolean().optional(), gender: z.enum(["male", "female"]).optional(), race: z.enum(["asian"]).optional(), hispanicLatino: z.boolean().optional() }).optional(),
});
export type CandidateProfile = z.infer<typeof CandidateProfile>;

export interface EvidenceLoad { items: EvidenceItem[]; profile: CandidateProfile | null; skippedSynthetic: string[]; errors: string[] }

const isSyntheticName = (f: string) => /\.synthetic\.json$/i.test(f);

/** Load verified evidence from `dir` and `dir/private`. Synthetic fixtures are refused unless allowSynthetic (tests only). */
export function loadEvidence(dir: string, opts: { allowSynthetic?: boolean } = {}): EvidenceLoad {
  const out: EvidenceLoad = { items: [], profile: null, skippedSynthetic: [], errors: [] };
  const dirs = [dir, join(dir, "private")].filter((d) => existsSync(d) && statSync(d).isDirectory());
  const seen = new Set<string>();
  for (const d of dirs) {
    for (const f of readdirSync(d).filter((n) => n.endsWith(".json"))) {
      const path = join(d, f);
      let raw: any;
      try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { out.errors.push(`${path}: invalid JSON`); continue; }
      if (f === "profile.json") {
        const p = CandidateProfile.safeParse(raw);
        if (p.success) out.profile = p.data; else out.errors.push(`${path}: ${p.error.issues[0]?.message}`);
        continue;
      }
      const synthetic = isSyntheticName(f) || raw?._synthetic === true;
      if (synthetic && !opts.allowSynthetic) { out.skippedSynthetic.push(path); continue; }
      const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : null;
      if (!arr) { out.errors.push(`${path}: expected array or {items:[]}`); continue; }
      for (const it of arr) {
        const r = EvidenceItem.safeParse(it);
        if (!r.success) { out.errors.push(`${path}: item ${it?.id ?? "?"}: ${r.error.issues[0]?.message}`); continue; }
        if (seen.has(r.data.id)) { out.errors.push(`${path}: duplicate id ${r.data.id}`); continue; }
        seen.add(r.data.id); out.items.push(r.data);
      }
    }
  }
  return out;
}
