// Answers to eligibility/EEO questions, taken ONLY from values the user saved in their own profile. Never inferred or guessed:
// an unset value (or any topic not listed here) returns null and the question goes to the user as an exception.
export interface Eligibility {
  usCitizen?: boolean; authorizedToWorkUS?: boolean; requiresSponsorship?: boolean; veteran?: boolean; disability?: boolean;
  gender?: "male" | "female"; race?: "asian"; hispanicLatino?: boolean; previouslyInterviewed?: boolean;
}
export interface Wanted { text: string; pick: RegExp }

const yesNo = (v: boolean): Wanted => (v ? { text: "Yes", pick: /^\s*yes\b/i } : { text: "No", pick: /^\s*no\b/i });

export function wantedAnswer(topic: string, question: string, e?: Eligibility): Wanted | null {
  if (!e) return null;
  const q = question.toLowerCase();
  if (topic === "work authorization / sponsorship") {
    if (/sponsor|visa/.test(q)) return e.requiresSponsorship === undefined ? null : yesNo(e.requiresSponsorship);
    if (/citizen/.test(q) && !/authori[sz]|legally|right to work/.test(q)) return e.usCitizen === undefined ? null : yesNo(e.usCitizen);
    return e.authorizedToWorkUS === undefined ? null : yesNo(e.authorizedToWorkUS);
  }
  if (topic === "prior interview") return e.previouslyInterviewed === undefined ? null : yesNo(e.previouslyInterviewed);
  if (topic === "veteran status" && e.veteran === false)
    return { text: "I am not a protected veteran", pick: /not a (protected )?veteran|am not a|^\s*no\b/i };
  if (topic === "disability" && e.disability === false)
    return { text: "No, I do not have a disability", pick: /no,? i (do not|don'?t) have|^\s*no\b/i };
  if (topic === "gender / orientation") {
    if (/pronoun|orientation|transgender/.test(q) || e.gender !== "male") return null;
    return { text: "Male", pick: /^\s*(male|man)\b/i };
  }
  if (topic === "race / ethnicity") {
    if (/hispanic|latino/.test(q) && !/race/.test(q)) return e.hispanicLatino === undefined ? null : yesNo(e.hispanicLatino);
    if (e.race === "asian") return { text: "Asian", pick: /\basian\b|^(?!.*(alaska|native)).*\bindian\b/i };
    return null;
  }
  return null;
}
