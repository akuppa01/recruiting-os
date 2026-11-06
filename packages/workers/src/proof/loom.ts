import type { CompanyResearch } from "../research/types.js";

const mmss = (t: number): string => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;

/** Timed Loom walkthrough script (markdown). ~2 min total. Uses only labelled research content. */
export function loomScript(r: CompanyResearch, opts: { candidateName?: string; roleTitle?: string; pageUrl?: string | null } = {}): string {
  const name = opts.candidateName ?? "[your name]";
  const top = r.ideas.slice(0, 3);
  const prod = r.product.find((c) => c.kind === "sourced") ?? r.product[0];
  const beats: Array<[string, string, string]> = [
    ["0:00-0:15", "Hook", `Hi, I'm ${name}. I spent time studying ${r.company}${opts.roleTitle ? ` ahead of applying for ${opts.roleTitle}` : ""} and put together a short public-source analysis. Not internal data, just what I could learn from the outside.`],
    ["0:15-0:35", "What I understood", prod ? `Here's how I understand the product: ${prod.text}${prod.kind !== "sourced" ? " (my interpretation)" : ""}` : `Briefly state what ${r.company} does in your own words.`],
    ...top.map((i, n): [string, string, string] => [`${mmss(35 + n * 30)}-${mmss(65 + n * 30)}`, `Idea ${n + 1}: ${i.title}`, `${i.rationale} Say clearly that this is a ${i.kind} and that you'd want to validate it with the team.`]),
    [`${mmss(35 + top.length * 30)}-${mmss(50 + top.length * 30)}`, "Close", `Thank them for their time, say what you'd like to explore together, and mention the page link${opts.pageUrl ? ` (${opts.pageUrl})` : " (add link once deployed)"}. Ask for a 15-minute chat.`],
  ];
  return [`# Loom script: ${r.company}`, "", "_Target length ~2 minutes (shorter if fewer ideas). Do not present speculation as fact._", "",
    ...beats.map(([t, h, s]) => `**[${t}] ${h}**\n${s}\n`)].join("\n");
}
