import type { AutomationPolicy, Ctx, EvidenceItem, OutreachRow, Store } from "@ros/core";
import { draftEmail, type DraftInput } from "./draft.js";
import { DAY_MS, nextAllowed } from "./time.js";

export interface PlannedStep { step: number; scheduledFor: string }

/** Step 0 at the next allowed time >= start; follow-ups at start + followUpDays (days after step 0), each pushed out of quiet hours. */
export function planSequence(start: Date, policy: Pick<AutomationPolicy, "followUpDays" | "quietHours">): PlannedStep[] {
  const t0 = nextAllowed(start, policy.quietHours);
  return [
    { step: 0, scheduledFor: t0.toISOString() },
    ...policy.followUpDays.map((d, i) => ({ step: i + 1, scheduledFor: nextAllowed(new Date(t0.getTime() + d * DAY_MS), policy.quietHours).toISOString() })),
  ];
}

export interface SequenceInput extends Omit<DraftInput, "step" | "evidence"> {
  contactId: string; jobId: string | null; evidence: EvidenceItem[];
}

/**
 * Persist the whole sequence. Rows are 'scheduled' only when policy.autoOutreach; otherwise 'draft'
 * (visible for review, never executed by the tick). Idempotent: if the contact already has rows for this job, nothing is created.
 */
export async function scheduleSequence(
  store: Pick<Store, "createOutreach" | "listOutreach" | "logEvent">, ctx: Ctx, input: SequenceInput,
  policy: AutomationPolicy, now: Date,
): Promise<OutreachRow[]> {
  const existing = await store.listOutreach(ctx, { contactId: input.contactId, jobId: input.jobId ?? undefined });
  if (existing.length) return existing;
  const rows: OutreachRow[] = [];
  for (const p of planSequence(now, policy)) {
    const d = draftEmail({ ...input, step: p.step });
    rows.push(await store.createOutreach(ctx, {
      ctx, contactId: input.contactId, jobId: input.jobId, step: p.step, channel: "email",
      status: policy.autoOutreach ? "scheduled" : "draft", subject: d.subject, body: d.body, scheduledFor: p.scheduledFor,
    }));
  }
  await store.logEvent(ctx, "outreach.sequence_scheduled", "contact", input.contactId, { steps: rows.length, auto: policy.autoOutreach });
  return rows;
}

/** LinkedIn/X: never automated. Draft text is stored in an exception task for manual sending. */
export async function createManualChannelTask(
  store: Pick<Store, "raiseException">, ctx: Ctx,
  t: { channel: "linkedin" | "x"; contactId: string; contactName: string; draft: string },
) {
  return store.raiseException(ctx, {
    ctx, type: "platform_restricts_automation", entityType: "contact", entityId: t.contactId,
    detail: `Manual ${t.channel} message for ${t.contactName} (automated sending is not permitted on this platform). Draft:\n${t.draft}`,
  });
}
