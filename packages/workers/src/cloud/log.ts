// PII-safe logging. The cloud worker runs on a PUBLIC repo's Actions runner, so every log line is public.
// Log only ids, company, title, ATS, phase, outcome codes, counts and durations. This logger additionally redacts known
// personal strings and anything shaped like an email address or US phone number, as a second line of defense.
export interface Logger { line(msg: string): void; readonly lines: string[] }

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redactor(personal: Array<string | null | undefined>): (s: string) => string {
  const strings = personal.map((p) => (p ?? "").trim()).filter((p) => p.length >= 4);
  const personalRe = strings.length ? new RegExp(strings.map(escapeRe).join("|"), "gi") : null;
  return (s) => {
    let out = s.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
    if (personalRe) out = out.replace(personalRe, "[redacted]");
    return out;
  };
}

export function createLogger(opts: { personal?: Array<string | null | undefined>; sink?: (s: string) => void } = {}): Logger {
  const redact = redactor(opts.personal ?? []);
  const sink = opts.sink ?? ((s: string) => console.log(s));
  const lines: string[] = [];
  return { lines, line(msg: string) { const clean = redact(msg); lines.push(clean); sink(clean); } };
}
