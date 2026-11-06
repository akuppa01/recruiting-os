import type { AutomationPolicy } from "@ros/core";

export interface OutboundEmail { to: string; from: string; subject: string; body: string; threadId?: string | null }
export interface SendResult { messageId: string; threadId: string | null }

/** Gmail (or any authorized mailbox). `isVerified` must reflect a REAL, recently verified connection. */
export interface EmailSender {
  name: string;
  isVerified(): Promise<boolean>;
  send(m: OutboundEmail): Promise<SendResult>;
}

export type SendOutcome =
  | { status: "sent"; result: SendResult }
  | { status: "dry_run" }
  | { status: "blocked"; reason: "integration_not_verified" }
  | { status: "failed"; error: string };

/** Live only if policy.mode==='live' AND autoOutreach AND sender verified. Otherwise dry_run (never sends). */
export async function sendOrDryRun(policy: Pick<AutomationPolicy, "mode" | "autoOutreach">, sender: EmailSender, m: OutboundEmail): Promise<SendOutcome> {
  if (policy.mode !== "live" || !policy.autoOutreach) return { status: "dry_run" };
  if (!(await sender.isVerified())) return { status: "blocked", reason: "integration_not_verified" };
  try { return { status: "sent", result: await sender.send(m) }; }
  catch (e) { return { status: "failed", error: (e as Error).message }; }
}

/**
 * Gmail API adapter (googleapis, OAuth2 refresh token from env). UNTESTED against live Gmail: no credentials here.
 * isVerified() performs a real users.getProfile call; send() uses users.messages.send with gmail.send scope.
 */
export class GmailSender implements EmailSender {
  name = "gmail";
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  private async client() {
    const { google } = await import("googleapis");
    const o = new google.auth.OAuth2(this.env.GOOGLE_CLIENT_ID, this.env.GOOGLE_CLIENT_SECRET);
    o.setCredentials({ refresh_token: this.env.GMAIL_REFRESH_TOKEN });
    return google.gmail({ version: "v1", auth: o });
  }
  async isVerified(): Promise<boolean> {
    if (!this.env.GOOGLE_CLIENT_ID || !this.env.GOOGLE_CLIENT_SECRET || !this.env.GMAIL_REFRESH_TOKEN) return false;
    try { await (await this.client()).users.getProfile({ userId: "me" }); return true; } catch { return false; }
  }
  async send(m: OutboundEmail): Promise<SendResult> {
    const raw = Buffer.from(
      [`To: ${m.to}`, `From: ${m.from}`, `Subject: ${m.subject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "", m.body].join("\r\n"),
    ).toString("base64url");
    const r = await (await this.client()).users.messages.send({ userId: "me", requestBody: { raw, threadId: m.threadId ?? undefined } });
    if (!r.data.id) throw new Error("gmail send returned no message id");
    return { messageId: r.data.id, threadId: r.data.threadId ?? null };
  }
}
