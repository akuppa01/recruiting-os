import type { AtsKind } from "@ros/core";

/**
 * ATS adapters. `verified` is intentionally NOT a property here: live submission is gated by the
 * caller's `verifiedAdapters` set (default empty), flipped only after a supervised real-world check.
 * Selectors/patterns below are best-effort from public page conventions and are NOT live-verified.
 */
export interface AtsAdapter {
  kind: AtsKind;
  /** Where the application form lives, given the job's apply URL. */
  formUrl(applyUrl: string): string;
  submitSelectors: string[];
  confirmation: { urlPatterns: RegExp[]; textPatterns: RegExp[] };
}

export const greenhouse: AtsAdapter = {
  kind: "greenhouse",
  formUrl: (u) => u,
  submitSelectors: ["button[type=submit]:has-text('Submit')", "input[type=submit]", "button:has-text('Submit application')"],
  confirmation: { urlPatterns: [/\/confirmation/i, /[?&]application_confirmation/i], textPatterns: [/thank you for applying/i, /application (has been )?(submitted|received)/i] },
};
export const lever: AtsAdapter = {
  kind: "lever",
  formUrl: (u) => (/\/apply\/?$/.test(new URL(u).pathname) ? u : u.replace(/\/$/, "") + "/apply"),
  submitSelectors: ["button:has-text('Submit application')", "button[type=submit]"],
  confirmation: { urlPatterns: [/\/thanks/i], textPatterns: [/application submitted/i, /thanks for applying/i, /we(’|')?ve received your application/i] },
};
export const ashby: AtsAdapter = {
  kind: "ashby",
  formUrl: (u) => (/\/application\/?$/.test(new URL(u).pathname) ? u : u.replace(/\/$/, "") + "/application"),
  submitSelectors: ["button:has-text('Submit Application')", "button[type=submit]"],
  confirmation: { urlPatterns: [], textPatterns: [/application was successfully submitted/i, /thank you for applying/i, /we(’|')?ve received your application/i] },
};

export const ADAPTERS: Partial<Record<AtsKind, AtsAdapter>> = { greenhouse, lever, ashby };

export interface ConfirmationEvidence { kind: "confirmation_page_text"; detail: string; url: string }

/** Pure: returns evidence ONLY if the page positively shows a submission confirmation. Absence of an error is NOT confirmation. */
export function detectConfirmation(a: AtsAdapter, url: string, text: string): ConfirmationEvidence | null {
  for (const re of a.confirmation.textPatterns) {
    const m = text.match(re);
    if (m) return { kind: "confirmation_page_text", detail: `matched "${m[0]}"${a.confirmation.urlPatterns.some((p) => p.test(url)) ? " and confirmation URL" : ""}`, url };
  }
  return null;
}
