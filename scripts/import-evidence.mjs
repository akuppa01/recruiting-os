// Convert the user's resume_database.json (Bullet_Bank + Projects) into EvidenceItem JSON.
// Usage: node scripts/import-evidence.mjs <path/to/resume_database.json> <outDir>
// Rules come from the user's own README fact rules; nothing is invented here.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [src, outDir] = process.argv.slice(2);
if (!src || !outDir) { console.error("usage: import-evidence.mjs <resume_database.json> <outDir>"); process.exit(2); }
const db = JSON.parse(readFileSync(src, "utf8"));
mkdirSync(outDir, { recursive: true });

// Fact rules (user's README): Hold bullets stay off; unconfirmed claims quarantined; excluded projects never used.
const HOLD = new Set(["B10", "B17", "B28"]);
const UNCONFIRMED = new Set(["B34", "B37"]); // "2 clients" possible double count; confirm first
const EXCLUDED_PROJECTS = new Set(["P12", "P19"]); // Panda Playbooks (anonymous), Imperium Academy stub

// Employer/role/dates exactly as on the user's own Master_Resume (company-level entries), plus Additional Information groups.
const RESUME_ENTRY = {
  P01: ["Casuro.ai (via ASVA Group)", "Co-Founder & Head of Go-to-Market", "5/25 – Present"],
  P02: ["ASVA Group", "Founder & CEO", "5/25 – Present"], P03: ["ASVA Group", "Founder & CEO", "5/25 – Present"], P04: ["ASVA Group", "Founder & CEO", "5/25 – Present"],
  P05: ["Mitti AI", "Founder", "6/25 – 10/25"],
  P06: ["Lockheed Martin", "Software Engineer, F-22 Raptor Team", "7/23 – 5/25"],
  P07: ["Charity Advertising & Marketing Partners", "Account Executive", "8/24 – 12/24"],
  P08: ["Additional Information", "Projects", "n/a"], P09: ["Additional Information", "Podcast", "n/a"], P10: ["Additional Information", "Projects", "n/a"],
  P11: ["Additional Information", "Projects", "n/a"], P15: ["Additional Information", "Projects", "n/a"],
  P16: ["Carnegie Mellon University, Tepper School of Business", "Team project", "n/a"], P17: ["Carnegie Mellon University, Tepper School of Business", "Team project", "n/a"],
  P18: ["Carnegie Mellon University, Tepper School of Business", "Honors", "n/a"],
};
const proj = new Map(db.projects.map((p) => [p["Project_ID"], p]));
const items = [], quarantine = [];
for (const b of db.bullets) {
  const id = b["Bullet_ID"], pid = b["Project_ID"], p = proj.get(pid);
  const statement = b["Bullet (past tense, outcome first)"];
  const reasons = [];
  if (HOLD.has(id) || b["In_GTM_Draft"] === "Hold") reasons.push("Hold: fact not confirmed (user README rule 3)");
  if (UNCONFIRMED.has(id)) reasons.push("Unconfirmed claim (client count / possible double count)");
  if (EXCLUDED_PROJECTS.has(pid)) reasons.push("Project excluded by user rule");
  if (!p) reasons.push("Unknown project id");
  if (p && !RESUME_ENTRY[pid] && [p["Start"], p["End"], p["Role"], p["Venture / Org"]].some((v) => !v || /NEEDED|TBD|\?\?/i.test(String(v)))) reasons.push("Dates/role/employer still NEEDED in the database; confirm before use");
  const metrics = b["Contains a number? (Y/N)"] === "Y" ? [...statement.matchAll(/\d[\d,.]*\+?%?(?:\s(?:[A-Za-z-]+))?/g)].map((m) => m[0].trim()) : [];
  const item = {
    id: `${id.toLowerCase()}-${pid.toLowerCase()}`,
    employer: RESUME_ENTRY[pid]?.[0] ?? p?.["Venture / Org"] ?? "unknown", role: RESUME_ENTRY[pid]?.[1] ?? p?.["Role"] ?? "unknown",
    dates: RESUME_ENTRY[pid]?.[2] ?? (p ? `${p["Start"]} – ${p["End"]}` : "unknown"),
    statement, metrics,
    tags: [...String(b["Tracks"]).split(";").map((s) => `track:${s.trim()}`), ...String(b["Skill tags"]).split(",").map((s) => s.trim()).filter(Boolean)],
    verifiedBy: "supporting_doc", sourceDoc: "resume_database.json (Bullet_Bank " + id + ")",
    strength: b["Strength (1-5)"],
  };
  (reasons.length ? quarantine.push({ ...item, quarantineReasons: reasons }) : items.push(item));
}
// `strength` is not in EvidenceItem; keep it out of the loadable file (zod strips unknown keys but be explicit).
writeFileSync(join(outDir, "evidence.json"), JSON.stringify(items.map(({ strength, ...r }) => r), null, 2));
writeFileSync(join(outDir, "quarantine.json.txt"), JSON.stringify(quarantine, null, 2)); // .txt: loader must never read it
console.log(`evidence items: ${items.length}; quarantined: ${quarantine.length} (${quarantine.map((q) => q.id).join(", ")})`);
