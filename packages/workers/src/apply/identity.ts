// Applicant identity guard: the business address (@asvagroup.org) must never be used on an application.
export const FORBIDDEN_EMAIL_RE = /@asvagroup\.org\s*$/i;
const FORBIDDEN_EMAIL_ANYWHERE = /[\w.+-]+@asvagroup\.org/gi;

export class ForbiddenApplicantEmailError extends Error {
  constructor(email: string) {
    super(`Refusing to apply: the applicant email resolved to ${email}, a business address that must never be used on applications. ` +
      `Set profiles.application_profile.email to the applicant (Tepper) address and re-run.`);
    this.name = "ForbiddenApplicantEmailError";
  }
}

export const isForbiddenEmail = (email: string | null | undefined): boolean => !!email && FORBIDDEN_EMAIL_RE.test(email.trim());

/** Replaces any business address in free text (e.g. a resume contact line) so it can never reach a model prompt or an answer. */
export const scrubForbiddenEmails = (text: string): string => text.replace(FORBIDDEN_EMAIL_ANYWHERE, "[email removed]");

/**
 * The applicant email comes from profiles.application_profile.email; the resume header is only a fallback when that is absent.
 * Throws ForbiddenApplicantEmailError when the result is a business address.
 */
export function resolveApplicantEmail(applicationProfileEmail: string | null | undefined, resumeHeaderEmail: string | null | undefined): string {
  const email = (applicationProfileEmail ?? "").trim() || (resumeHeaderEmail ?? "").trim();
  if (!email) throw new Error("No applicant email found in application_profile.email or the resume header");
  if (isForbiddenEmail(email)) throw new ForbiddenApplicantEmailError(email);
  return email;
}
