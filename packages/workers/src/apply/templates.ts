// ATS form memory: stable form signatures + a shared template store (selectors/labels/classification only, NEVER applicant answers).
import { createHash } from "node:crypto";
import type { AtsKind, FormFieldMapping, FormTemplate, FormTemplateStore } from "@ros/core";
import type { RawField, ScannedField } from "./browser.js";
import type { FieldClass, FieldKey } from "./fields.js";

/** Bump when classifyField/answer logic changes so stale stored classifications are not reused. */
export const CLASSIFIER_VERSION = 1;

export const normLabel = (s: string): string => s.toLowerCase().replace(/\*/g, "").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);

export const controlKind = (f: Pick<RawField, "tag" | "type" | "combo">): FormFieldMapping["kind"] =>
  f.tag === "select" ? "select" : f.type === "file" ? "file" : f.type === "radio" ? "radio" : f.type === "checkbox" ? "checkbox" : f.tag === "textarea" ? "textarea" : f.combo ? "combobox" : "text";

export const fieldKeyOf = (f: RawField): string => `${controlKind(f)}|${normLabel(f.group || f.label)}`;

/** Order-independent hash of the form's field structure (control kinds + normalized labels). */
export function formSignature(raw: RawField[]): string {
  const keys = raw.filter((f) => f.type !== "search").map(fieldKeyOf).sort();
  return createHash("sha1").update(keys.join("\n")).digest("hex").slice(0, 16);
}

const KEYS = new Set<string>(["first_name", "last_name", "full_name", "email", "phone", "linkedin", "website", "location", "resume", "cover_letter_text", "cover_letter_file"]);

export function encodeCls(c: FieldClass): string {
  if (c.kind === "known") return c.key;
  if (c.kind === "sensitive") return `sensitive:${c.topic}`;
  return c.kind;
}
export function decodeCls(s: string): FieldClass | null {
  if (KEYS.has(s)) return { kind: "known", key: s as FieldKey };
  if (s.startsWith("sensitive:")) return { kind: "sensitive", topic: s.slice("sensitive:".length) };
  if (s === "ack" || s === "essay" || s === "unknown") return { kind: s };
  return null;
}

/** Lookup table from a stored template: `kind|label` -> classification. Empty when the template is stale. */
export function templateLookup(t: FormTemplate | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!t || t.version !== CLASSIFIER_VERSION) return m;
  for (const f of t.fieldMap) m.set(`${f.kind}|${f.label}`, f.mapsTo);
  return m;
}

export interface TemplateDraft {
  provider: AtsKind; signature: string; version: number; fieldMap: FormFieldMapping[];
  uploadBehavior: FormTemplate["uploadBehavior"]; validationRules: Record<string, unknown>; confirmationSignals: FormTemplate["confirmationSignals"];
}

export function templateFromScan(provider: AtsKind, signature: string, fields: ScannedField[], extra: { uploadBehavior?: FormTemplate["uploadBehavior"]; confirmationSignals?: FormTemplate["confirmationSignals"]; validationRules?: Record<string, unknown> } = {}): TemplateDraft {
  const seen = new Set<string>();
  const fieldMap: FormFieldMapping[] = [];
  for (const f of fields) {
    const k = fieldKeyOf(f);
    if (seen.has(k)) continue;
    seen.add(k);
    fieldMap.push({ label: normLabel(f.group || f.label), selector: f.name ? `[name="${f.name}"]` : f.selector, kind: controlKind(f), mapsTo: encodeCls(f.cls) });
  }
  return {
    provider, signature, version: CLASSIFIER_VERSION, fieldMap,
    uploadBehavior: extra.uploadBehavior ?? {}, validationRules: extra.validationRules ?? {},
    confirmationSignals: extra.confirmationSignals ?? { urlPatterns: [], textPatterns: [] },
  };
}

const blank = (provider: AtsKind, signature: string): FormTemplate => ({
  provider, signature, version: CLASSIFIER_VERSION, fieldMap: [], uploadBehavior: {}, validationRules: {},
  confirmationSignals: { urlPatterns: [], textPatterns: [] }, successCount: 0, failureCount: 0, lastSuccessAt: null, lastFailureAt: null,
});

export class InMemoryFormTemplateStore implements FormTemplateStore {
  readonly rows = new Map<string, FormTemplate>();
  async get(provider: AtsKind, signature: string) { return this.rows.get(`${provider}:${signature}`) ?? null; }
  async recordSuccess(t: Pick<FormTemplate, "provider" | "signature"> & Partial<FormTemplate>) {
    const key = `${t.provider}:${t.signature}`;
    const cur = this.rows.get(key) ?? blank(t.provider, t.signature);
    this.rows.set(key, { ...cur, ...stripUndefined(t), successCount: cur.successCount + 1, lastSuccessAt: new Date().toISOString() });
  }
  async recordFailure(provider: AtsKind, signature: string) {
    const key = `${provider}:${signature}`;
    const cur = this.rows.get(key);
    if (!cur) return; // nothing learned about this form yet (mirrors the Supabase store)
    this.rows.set(key, { ...cur, failureCount: cur.failureCount + 1, lastFailureAt: new Date().toISOString() });
  }
}

const stripUndefined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Minimal structural type for a Supabase client (avoids a direct dependency on @supabase/supabase-js). */
export interface SbLike { from(table: string): any }

/** Shared table public.ats_form_templates (service role). Holds selectors, labels and classifications only. */
export class SupabaseFormTemplateStore implements FormTemplateStore {
  constructor(private readonly sb: SbLike) {}
  private toTemplate(r: any): FormTemplate {
    return {
      provider: r.provider, signature: r.signature, version: r.version, fieldMap: r.field_map ?? [], uploadBehavior: r.upload_behavior ?? {},
      validationRules: r.validation_rules ?? {}, confirmationSignals: r.confirmation_signals ?? { urlPatterns: [], textPatterns: [] },
      successCount: r.success_count, failureCount: r.failure_count, lastSuccessAt: r.last_success_at, lastFailureAt: r.last_failure_at,
    };
  }
  async get(provider: AtsKind, signature: string) {
    const { data, error } = await this.sb.from("ats_form_templates").select("*").eq("provider", provider).eq("signature", signature).maybeSingle();
    if (error) throw new Error(`ats_form_templates.get: ${error.message}`);
    return data ? this.toTemplate(data) : null;
  }
  async recordSuccess(t: Pick<FormTemplate, "provider" | "signature"> & Partial<FormTemplate>) {
    const cur = await this.get(t.provider, t.signature);
    const row = {
      provider: t.provider, signature: t.signature, version: t.version ?? cur?.version ?? CLASSIFIER_VERSION,
      field_map: t.fieldMap ?? cur?.fieldMap ?? [], upload_behavior: t.uploadBehavior ?? cur?.uploadBehavior ?? {},
      validation_rules: t.validationRules ?? cur?.validationRules ?? {}, confirmation_signals: t.confirmationSignals ?? cur?.confirmationSignals ?? { urlPatterns: [], textPatterns: [] },
      success_count: (cur?.successCount ?? 0) + 1, failure_count: cur?.failureCount ?? 0, last_success_at: new Date().toISOString(), last_failure_at: cur?.lastFailureAt ?? null,
    };
    const { error } = await this.sb.from("ats_form_templates").upsert(row, { onConflict: "provider,signature" });
    if (error) throw new Error(`ats_form_templates.recordSuccess: ${error.message}`);
  }
  async recordFailure(provider: AtsKind, signature: string) {
    const cur = await this.get(provider, signature);
    if (!cur) return; // nothing learned about this form yet; do not create an empty template from a failure
    const { error } = await this.sb.from("ats_form_templates").update({ failure_count: cur.failureCount + 1, last_failure_at: new Date().toISOString() }).eq("provider", provider).eq("signature", signature);
    if (error) throw new Error(`ats_form_templates.recordFailure: ${error.message}`);
  }
}
