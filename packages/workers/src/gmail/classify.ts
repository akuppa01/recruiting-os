// Reply / rejection / opt-out classification + sequence-stopping hooks used by outreach (Agent C) and the gmail poller.
import type { Ctx, Store } from "@ros/core";
import { notify, type Notifier } from "../notify/index.js";

export type InboundClass = "opt_out" | "rejection" | "interview" | "auto_reply" | "positive_reply" | "referral" | "unknown";

const R = {
  opt: /\b(unsubscribe|remove me|stop (?:emailing|contacting|sending)|do not (?:contact|email)|don'?t (?:contact|email)|opt[- ]?out|take me off)\b/i,
  auto: /\b(out of (?:the )?office|automatic reply|auto[- ]?reply|on vacation|away from (?:my )?(?:desk|email)|will respond when i return)\b/i,
  rej: /\b(unfortunately|regret to inform|not (?:be )?moving forward|decided to (?:move|proceed) (?:forward )?with other|not selected|position has been filled|will not be (?:moving|proceeding)|no longer (?:considering|hiring))\b/i,
  intv: /\b(schedule (?:a |an )?(?:call|interview|chat|time)|set up (?:a )?(?:call|interview|time)|(?:phone|video|first[- ]round|technical) (?:screen|interview)|interview (?:invitation|invite)|available (?:for|to) (?:a )?(?:call|chat)|calendly\.com|send (?:me )?(?:your )?availability|(?:30|15)[- ]minute (?:call|chat))\b/i,
  ref: /\b(reach out to|connect(?:ing)? you (?:with|to)|loop(?:ing)? in|cc'?ing|introduc(?:e|ing) you|forward(?:ed|ing) (?:this|your))\b/i,
};

/** Order matters: opt-out and auto-reply win; rejection before interview wording ("unfortunately ... schedule"). */
export function classifyInbound(subject: string, body: string): InboundClass {
  const t = `${subject}\n${body}`;
  if (R.auto.test(t)) return "auto_reply";
  if (R.opt.test(t)) return "opt_out";
  if (R.rej.test(t)) return "rejection";
  if (R.intv.test(t)) return "interview";
  if (R.ref.test(t)) return "referral";
  return t.trim().length > 0 && body.trim().length > 8 ? "positive_reply" : "unknown";
}

export interface InboundReplyEvent { contactId: string; jobId?: string; subject: string; body: string; threadId?: string }

/** Stop sequences on reply/rejection/opt-out; notify on important outcomes; never sends anything itself. */
export async function handleInboundReply(store: Store, ctx: Ctx, notifier: Notifier, ev: InboundReplyEvent): Promise<{ class: InboundClass; stopped: boolean }> {
  const cls = classifyInbound(ev.subject, ev.body);
  await store.logEvent(ctx, "reply.received", "contact", ev.contactId, { class: cls, threadId: ev.threadId ?? null, jobId: ev.jobId ?? null });
  if (cls === "auto_reply" || cls === "unknown") return { class: cls, stopped: false };
  const reason = cls === "opt_out" ? "opt_out" : cls === "rejection" ? "rejection" : "replied";
  await store.suppressContact(ctx, ev.contactId, reason);           // also stops pending outreach (Store contract)
  await store.logEvent(ctx, "outreach.stopped", "contact", ev.contactId, { reason });
  if (ev.jobId) {
    if (cls === "interview") await store.setJobStage(ctx, ev.jobId, "interviewing");
    if (cls === "rejection") await store.setJobStage(ctx, ev.jobId, "rejected");
  }
  const kind = cls === "interview" ? "interview" : cls === "rejection" ? "rejection" : cls === "opt_out" ? null : "reply";
  if (kind) await notify(store, ctx, notifier, { kind, title: kind === "interview" ? "Interview signal" : kind === "rejection" ? "Rejection received" : "Reply received", body: ev.subject });
  return { class: cls, stopped: true };
}
