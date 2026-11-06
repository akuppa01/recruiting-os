import type { AtsKind } from "@ros/core";

export interface AtsInfo { kind: AtsKind; jobId: string | null; board: string | null }

/** Detect ATS kind + job id from a public job URL. Pure; no network. */
export function detectAts(rawUrl: string | null | undefined): AtsInfo {
  if (!rawUrl) return { kind: "unknown", jobId: null, board: null };
  let u: URL;
  try { u = new URL(rawUrl); } catch { return { kind: "unknown", jobId: null, board: null }; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io" || host.endsWith(".greenhouse.io")) {
    const board = parts[0] ?? null;
    const idx = parts.indexOf("jobs");
    const id = (idx >= 0 ? parts[idx + 1] : null) ?? u.searchParams.get("gh_jid");
    return { kind: "greenhouse", jobId: id ?? null, board };
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    return { kind: "lever", board: parts[0] ?? null, jobId: parts[1] ?? null };
  }
  if (host === "jobs.ashbyhq.com") {
    return { kind: "ashby", board: parts[0] ?? null, jobId: parts[1] ?? null };
  }
  const gh = u.searchParams.get("gh_jid");
  if (gh) return { kind: "greenhouse", jobId: gh, board: null };
  if (host.endsWith(".myworkdayjobs.com")) return { kind: "workday", jobId: parts[parts.length - 1] ?? null, board: host.split(".")[0] ?? null };
  if (host.endsWith(".icims.com")) return { kind: "icims", jobId: null, board: host.split(".")[0] ?? null };
  if (host === "jobs.smartrecruiters.com") return { kind: "smartrecruiters", board: parts[0] ?? null, jobId: parts[1] ?? null };
  return { kind: "unknown", jobId: null, board: null };
}
