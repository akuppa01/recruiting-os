import type { Ctx, Store } from "@ros/core";

export type ReplyKind = "opt_out" | "rejection" | "bounce" | "auto_reply" | "reply";

const OPT = /\b(unsubscribe|stop (emailing|contacting|messaging)|remove me|do not contact|don'?t contact|take me off|opt[- ]?out)\b/i;
const BOUNCE = /(mailer-daemon|delivery status notification|undeliverable|address not found|550 5\.\d\.\d)/i;
const AUTO = /(out of (the )?office|automatic reply|auto-?reply|away from (my )?(desk|email)|on (annual )?leave until)/i;
const REJECT = /(not hiring|no (open )?(positions|openings|roles)|position (has been|is) filled|we('| a)re not (able|looking)|unfortunately|not a fit|will not be moving forward)/i;

/** Order matters: opt-out beats everything; bounce/auto-reply are machine messages. */
export function classifyReply(text: string, from = ""): ReplyKind {
  const t = `${from}\n${text}`;
  if (BOUNCE.test(t)) return "bounce";
  if (OPT.test(text)) return "opt_out";
  if (AUTO.test(text)) return "auto_reply";
  if (REJECT.test(text)) return "rejection";
  return "reply";
}

export interface Inbound { text: string; from?: string }

/**
 * Apply an inbound message to a contact. Any human reply, rejection, opt-out or bounce suppresses the contact
 * (Store.suppressContact also stops pending steps). Auto-replies do nothing. Returns what happened.
 */
export async function processInbound(
  store: Pick<Store, "suppressContact" | "logEvent">, ctx: Ctx, contactId: string, msg: Inbound,
): Promise<{ kind: ReplyKind; suppressed: boolean }> {
  const kind = classifyReply(msg.text, msg.from);
  if (kind === "auto_reply") {
    await store.logEvent(ctx, "outreach.auto_reply", "contact", contactId, {});
    return { kind, suppressed: false };
  }
  const reason = kind === "reply" ? "replied" : kind;
  await store.suppressContact(ctx, contactId, reason);
  await store.logEvent(ctx, `outreach.${kind}`, "contact", contactId, { reason });
  return { kind, suppressed: true };
}
