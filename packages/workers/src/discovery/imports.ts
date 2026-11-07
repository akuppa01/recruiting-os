// On-demand sources: manual URL/JD, CSV/XLSX-as-CSV rows, WhatsApp chat exports. Thin wrappers over the existing ingest adapters.
import type { DiscoveredJob, IngestRequest, SourceAdapter, SourceId, SourceRunResult } from "@ros/core";
import { csvToIngestRequests, parseWhatsAppExport } from "../gmail/ingest-adapters.js";
import { normalizeJob, rawFromRequest } from "../normalize/index.js";
import { canonicalizeUrl } from "./url.js";

function toDiscovered(source: SourceId, kind: "import" | "manual", requests: IngestRequest[]): DiscoveredJob[] {
  const out: DiscoveredJob[] = [];
  for (const r of requests) {
    if (r.job) {
      const url = r.job.applyUrl ?? r.job.sourceUrl ?? r.url ?? null;
      out.push({ source, sourceRef: r.idempotencyKey ?? url ?? r.job.title, canonicalUrl: url ? canonicalizeUrl(url) : null, job: r.job, evidence: { kind, excerpt: r.note } });
    } else if (r.text) {
      const n = normalizeJob(rawFromRequest(r)); // pasted JD: offline extraction, nothing guessed
      out.push({
        source, sourceRef: r.idempotencyKey ?? `text:${n.dedupeKey}`, canonicalUrl: null,
        job: { title: n.title, company: n.company, location: n.location ?? undefined, description: n.description, deadline: n.deadline ?? undefined },
        evidence: { kind, excerpt: r.note ?? r.text.slice(0, 160) },
      });
    } else if (r.url) {
      // URL only: title/company are resolved later by URL enrichment (placeholders mark that).
      out.push({
        source, sourceRef: r.idempotencyKey ?? r.url, canonicalUrl: canonicalizeUrl(r.url),
        job: { title: "Untitled role", company: "Unknown company", applyUrl: r.url, sourceUrl: r.url },
        evidence: { kind, excerpt: r.note },
      });
    }
  }
  return out;
}

const done = (source: SourceId, jobs: DiscoveredJob[], notes: string[] = []): SourceRunResult =>
  ({ source, jobs, ...(notes.length ? { error: notes.join("; ") } : {}) });

export function createManualAdapter(input: { urls?: string[]; texts?: string[] }): SourceAdapter {
  return {
    id: "manual", kind: "import",
    async run() {
      const reqs: IngestRequest[] = [
        ...(input.urls ?? []).filter((u) => /^https?:\/\/\S+$/.test(u.trim())).map((url) => ({ source: "manual_url", url: url.trim(), idempotencyKey: `manual:${url.trim()}` }) as IngestRequest),
        ...(input.texts ?? []).filter((t) => t.trim().length > 40).map((text, i) => ({ source: "manual_text", text, idempotencyKey: `manual-text:${i}:${text.slice(0, 40)}` }) as IngestRequest),
      ];
      return done("manual", toDiscovered("manual", "manual", reqs));
    },
  };
}

export function createCsvAdapter(csvText: string): SourceAdapter {
  return {
    id: "csv", kind: "import",
    async run() {
      const { requests, skipped } = csvToIngestRequests(csvText);
      return done("csv", toDiscovered("csv", "import", requests), skipped.map((s) => `row ${s.row}: ${s.reason}`));
    },
  };
}

export function createWhatsAppAdapter(chatText: string, o: { includeAllUrls?: boolean } = {}): SourceAdapter {
  return {
    id: "whatsapp", kind: "import",
    async run() { return done("whatsapp", toDiscovered("whatsapp", "import", parseWhatsAppExport(chatText, o))); },
  };
}
