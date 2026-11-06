// Gmail connector. Live ONLY with OAuth credentials; otherwise returns an explicit not-connected result (never fake data).
import type { EmailLike } from "./alerts.js";

export type NotConnected = { connected: false; reason: string };
export interface GmailConnector {
  connected: true;
  listRecent(query: string, max?: number): Promise<Array<EmailLike & { threadId?: string }>>;
  createDraft(to: string, subject: string, body: string): Promise<{ draftId: string }>;
  send(to: string, subject: string, body: string, threadId?: string): Promise<{ messageId: string; threadId: string }>;
}
export type GmailResult = GmailConnector | NotConnected;

const b64u = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const header = (h: any[] | undefined, n: string) => h?.find((x) => x.name?.toLowerCase() === n)?.value ?? "";
function bodyText(p: any): string {
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64").toString("utf8");
  return (p.parts ?? []).map(bodyText).join("\n");
}
export function rfc822(to: string, subject: string, body: string): string {
  if (/[\r\n]/.test(to + subject)) throw new Error("header injection rejected");
  return [`To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "", body].join("\r\n");
}

/** Wrap an already-authenticated googleapis gmail client (injectable for tests). */
export function gmailFromClient(gmail: any): GmailConnector {
  return {
    connected: true,
    async listRecent(query, max = 25) {
      const l = await gmail.users.messages.list({ userId: "me", q: query, maxResults: max });
      const out = [];
      for (const m of l.data.messages ?? []) {
        const g = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
        const h = g.data.payload?.headers;
        out.push({ from: header(h, "from"), subject: header(h, "subject"), text: bodyText(g.data.payload), date: header(h, "date"), messageId: m.id, threadId: g.data.threadId });
      }
      return out;
    },
    async createDraft(to, subject, body) {
      const r = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw: b64u(rfc822(to, subject, body)) } } });
      return { draftId: r.data.id };
    },
    async send(to, subject, body, threadId) {
      const r = await gmail.users.messages.send({ userId: "me", requestBody: { raw: b64u(rfc822(to, subject, body)), threadId } });
      return { messageId: r.data.id, threadId: r.data.threadId };
    },
  };
}

export async function createGmailConnectorFromEnv(env: Record<string, string | undefined> = process.env): Promise<GmailResult> {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, GMAIL_REFRESH_TOKEN: rt } = env;
  const missing = [["GOOGLE_CLIENT_ID", id], ["GOOGLE_CLIENT_SECRET", secret], ["GMAIL_REFRESH_TOKEN", rt]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { connected: false, reason: `Gmail not connected: missing ${missing.join(", ")}. See docs/SETUP.md#gmail` };
  const { google } = await import("googleapis");
  const auth = new google.auth.OAuth2(id, secret);
  auth.setCredentials({ refresh_token: rt });
  return gmailFromClient(google.gmail({ version: "v1", auth }));
}
