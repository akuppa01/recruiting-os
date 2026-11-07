// Applicant profile + resume helpers for the cloud worker (docx text via `unzip`, present on the ubuntu runner and macOS).
import { execFileSync } from "node:child_process";
import type { CandidateProfile } from "../resume/evidence.js";
import { resolveApplicantEmail } from "../apply/identity.js";
import type { ResumeBase } from "./assets.js";

const docxXml = (f: string) => execFileSync("unzip", ["-p", f, "word/document.xml"], { maxBuffer: 20_000_000 }).toString("utf8");
const textOf = (xml: string) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/gs)].map((m) => m[1]).join("");

export const docxText = (docx: string): string => (docxXml(docx).match(/<w:p[ >].*?<\/w:p>/gs) ?? []).map(textOf).filter((t) => t.trim()).join("\n");

/** Highlighted (unconfirmed) runs, per the resume system's rule that highlighted text must never be sent. */
export function highlightedText(docx: string): string[] {
  const out: string[] = [];
  for (const run of docxXml(docx).match(/<w:r[ >].*?<\/w:r>/gs) ?? []) {
    if (/<w:highlight w:val="[^"]+"/.test(run) || /<w:shd [^>]*w:fill="FFFF00"/.test(run)) { const t = textOf(run).trim(); if (t) out.push(t); }
  }
  return out;
}

export function readHeader(docx: string): { name: string; phone?: string; location?: string; email: string } {
  const paras = (docxXml(docx).match(/<w:p[ >].*?<\/w:p>/gs) ?? []).map(textOf).filter((t) => t.trim());
  const name = (paras[0] ?? "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  const contact = paras[1] ?? "";
  const email = contact.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] ?? "";
  const phone = contact.match(/\+?\d[\d .()-]{8,}\d/)?.[0]?.trim();
  const location = contact.replace(email, "").replace(phone ?? "", "").trim() || undefined;
  if (!name) throw new Error("Could not read the applicant name from the resume header");
  return { name, phone, location, email };
}

export interface ApplicationProfileRow {
  email?: string; linkedin?: string;
  eligibility?: Record<string, unknown>;
  answers?: Array<{ match: string; text: string; pick?: string; file?: string }>;
}

/** Builds the CandidateProfile. The applicant email comes from application_profile.email and is refused if it is the business address. */
export function buildCandidate(headerDocx: string, ap: ApplicationProfileRow): { profile: CandidateProfile; personal: string[] } {
  const h = readHeader(headerDocx);
  const email = resolveApplicantEmail(ap.email, h.email); // throws ForbiddenApplicantEmailError for @asvagroup.org
  const profile = { name: h.name, email, phone: h.phone, location: h.location, education: [] as string[], linkedin: ap.linkedin, eligibility: ap.eligibility as never, answers: ap.answers } as CandidateProfile;
  return { profile, personal: [h.name, email, h.phone ?? "", ap.linkedin ?? ""] };
}

export function pickResumeBase(role: string, title: string): ResumeBase {
  const t = title.toLowerCase();
  return /product manager|product management|\bpm\b/.test(t) || role === "product_management" ? "PM"
    : role === "founders_office" ? "Founders_Office"
    : role === "product_marketing" || role === "gtm_strategy" || role === "growth_brand" || /gtm|go-to-market|marketing|growth/.test(t) ? "GTM"
    : "Strategy";
}
