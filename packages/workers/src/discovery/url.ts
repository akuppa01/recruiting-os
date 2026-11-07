// URL canonicalization + dedupe keys for job postings from any source.
import { detectAts } from "../normalize/index.js";

// Tracking-only query params. gh_jid (Greenhouse job id on custom career pages) and Indeed's jk are NOT tracking: they identify the job.
const TRACKING = /^(utm_.*|gclid|fbclid|msclkid|mc_.*|ref|referrer|refid|refId|trk|trackingid|trkemail|source|src|gh_src|lever-source|lever-origin|ashby_source|ccuid|ceid|jobsource|ebp|midtoken|otptoken|rcm|campaignid|tk|from|fccid|vjs|advn|adid|sjdu|alid|cmp|mkt_tok|eid|lipi|trackingId|originalSubdomain|currentJobId|trk.*)$/i;

function parse(raw: string): URL | null {
  try { return new URL(raw.trim().replace(/[.,;)]+$/, "")); } catch { return null; }
}

export function canonicalizeUrl(raw: string): string {
  const u = parse(raw);
  if (!u) return raw.trim();
  const host = u.hostname.toLowerCase();

  const li = u.pathname.match(/\/jobs\/view\/(\d+)/i);
  if (host.endsWith("linkedin.com") && li) return `https://www.linkedin.com/jobs/view/${li[1]}`;

  if (host.endsWith("indeed.com")) {
    const jk = u.searchParams.get("jk");
    if (jk) return `https://www.indeed.com/viewjob?jk=${jk}`;
  }

  if (host.endsWith("joinhandshake.com")) { u.search = ""; u.hash = ""; return u.toString().replace(/\/$/, ""); }

  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hash = "";
  u.hostname = host;
  let s = u.toString();
  if (u.pathname !== "/" && s.endsWith("/") && !u.search) s = s.slice(0, -1);
  return s;
}

/** Stable identity of a posting across URL variants (school subdomains, wrappers, custom career pages). */
export function urlKey(raw: string): string {
  const u = parse(raw);
  if (!u) return raw.trim().toLowerCase();
  const host = u.hostname.toLowerCase();
  const li = u.pathname.match(/\/jobs\/view\/(\d+)/i);
  if (host.endsWith("linkedin.com") && li) return `linkedin:${li[1]}`;
  const jk = u.searchParams.get("jk");
  if (host.endsWith("indeed.com") && jk) return `indeed:${jk}`;
  const hs = u.pathname.match(/\/jobs\/(\d+)/i);
  if (host.endsWith("joinhandshake.com") && hs) return `handshake:${hs[1]}`;
  const a = detectAts(u.toString());
  if (a.kind !== "unknown" && a.jobId) return `${a.kind}:${a.jobId}`;
  return `${host.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
}
