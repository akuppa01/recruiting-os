// Minimal local Store fake for Agent C tests (until/unless @ros/db InMemoryStore is used).
import type { Ctx } from "@ros/core";
import { randomUUID } from "node:crypto";

export function makeFake() {
  const companies = new Map<string, any>(), contacts = new Map<string, any>(), outreach = new Map<string, any>();
  const events: any[] = [], exceptions: any[] = [], actions: any[] = [];
  const store: any = {
    async upsertCompany(ctx: Ctx, name: string, domain: string | null) {
      for (const c of companies.values()) if (c.name === name) return c;
      const c = { id: randomUUID(), ctx, name, domain, research: null, researchedAt: null }; companies.set(c.id, c); return c;
    },
    async saveCompanyResearch(_c: Ctx, id: string, r: unknown) { const c = companies.get(id); c.research = r; c.researchedAt = "now"; },
    async logEvent(_c: Ctx, kind: string, entityType: string, entityId: string | null, payload: any = {}) { events.push({ kind, entityType, entityId, payload }); },
    async upsertContact(ctx: Ctx, c: any) { const row = { ...c, id: randomUUID(), ctx, suppressed: false, suppressReason: null }; contacts.set(row.id, row); return row; },
    async listContacts(_c: Ctx, companyId: string) { return [...contacts.values()].filter((c) => c.companyId === companyId); },
    async suppressContact(_c: Ctx, id: string, reason: string) {
      const c = contacts.get(id); c.suppressed = true; c.suppressReason = reason;
      for (const o of outreach.values()) if (o.contactId === id && ["draft", "scheduled"].includes(o.status)) { o.status = "stopped"; o.stopReason = reason; }
    },
    async createOutreach(ctx: Ctx, o: any) { const row = { ...o, id: randomUUID(), ctx, sentAt: null, stopReason: null, threadId: null }; outreach.set(row.id, row); return row; },
    async updateOutreach(_c: Ctx, id: string, patch: any) { Object.assign(outreach.get(id), patch); },
    async listOutreach(_c: Ctx, q: any) {
      return [...outreach.values()].filter((o) => (!q.jobId || o.jobId === q.jobId) && (!q.contactId || o.contactId === q.contactId) && (!q.dueBefore || (o.scheduledFor && o.scheduledFor <= q.dueBefore)));
    },
    async raiseException(ctx: Ctx, e: any) { const row = { ...e, id: randomUUID(), ctx, createdAt: "now", resolvedAt: null }; exceptions.push(row); return row; },
    async recordExternalAction(_c: Ctx, a: any) { actions.push(a); },
    async getPreferences() { throw new Error("not used"); },
    async setJobStage() {}, async getJob() { return null; },
  };
  return { store, companies, contacts, outreach, events, exceptions, actions };
}
export const ctx: Ctx = { tenantId: "t1", userId: "u1" };
