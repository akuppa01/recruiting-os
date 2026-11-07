// Pure field classification (no browser). Decides what to fill, what to leave, what needs a human.
export type FieldKey =
  | "first_name" | "last_name" | "full_name" | "email" | "phone" | "linkedin" | "website" | "location"
  | "resume" | "cover_letter_text" | "cover_letter_file";

export type FieldClass =
  | { kind: "known"; key: FieldKey }
  | { kind: "essay" }                    // free-text question: drafted from verified facts, never invented
  | { kind: "sensitive"; topic: string }   // eligibility/EEO/legal questions: never auto-answered
  | { kind: "unknown" };

const SENSITIVE: Array<[string, RegExp]> = [
  ["work authorization / sponsorship", /sponsor|authori[sz]ed to work|work authori[sz]ation|legally (able|authori)|right to work|visa|citizen|immigration/i],
  ["veteran status", /veteran|military service/i],
  ["disability", /disabilit/i],
  ["race / ethnicity", /\brace\b|ethnic|hispanic|latino/i],
  ["gender / orientation", /\bgender\b|pronoun|sexual orientation|transgender/i],
  ["criminal history", /convict|criminal|felony/i],
  ["security clearance", /clearance/i],
  ["age / date of birth", /date of birth|\bdob\b|your age|over 18|18 years/i],
  ["non-compete / agreements", /non-?compete|restrictive covenant/i],
];

const KNOWN: Array<[FieldKey, RegExp]> = [
  ["first_name", /^(first|given)[ _-]?name|\bfirst name\b|_systemfield_first/i],
  ["last_name", /^(last|family|sur)[ _-]?name|\blast name\b|\bsurname\b/i],
  ["full_name", /^(full[ _-]?)?name$|\bfull name\b|^your name|_systemfield_name|legal name/i],
  ["email", /e-?mail/i],
  ["phone", /phone|mobile|\btel\b/i],
  ["linkedin", /linkedin/i],
  ["website", /website|portfolio|personal (site|url)|github/i],
  ["location", /current location|\bcity\b|location|where are you based/i],
  ["cover_letter_text", /cover letter|additional information|why (do you want|are you interested)/i],
];

export function classifyField(label: string, name = "", type = ""): FieldClass {
  const hay = `${label} ${name}`.trim();
  if (type === "file") return /cover/i.test(hay) ? { kind: "known", key: "cover_letter_file" } : /resume|cv/i.test(hay) || !hay ? { kind: "known", key: "resume" } : { kind: "unknown" };
  for (const [topic, re] of SENSITIVE) if (re.test(hay)) return { kind: "sensitive", topic };
  for (const [key, re] of KNOWN) if (re.test(label.trim()) || re.test(name)) return { kind: "known", key };
  if (type === "textarea" && label.trim()) return { kind: "essay" };
  return { kind: "unknown" };
}

export function splitName(full: string): { first: string; last: string } {
  const p = full.trim().split(/\s+/);
  return { first: p[0] ?? "", last: p.slice(1).join(" ") };
}
