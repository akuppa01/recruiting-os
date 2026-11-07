// Essay-draft cache so repeated runs never re-spend AI on a question already answered for a job.
// Stored privately in Storage bucket 'ingest-files' at '<user_id>/drafts/<job_id>.json'. Contents are never logged.
import type { StorageLike } from "./assets.js";

export type Drafts = Record<string, { text: string; approved: boolean }>;
export interface DraftCache { get(jobId: string): Promise<Drafts>; put(jobId: string, d: Drafts): Promise<void> }

export class InMemoryDraftCache implements DraftCache {
  data = new Map<string, Drafts>();
  async get(jobId: string) { return { ...(this.data.get(jobId) ?? {}) }; }
  async put(jobId: string, d: Drafts) { this.data.set(jobId, { ...d }); }
}

export class StorageDraftCache implements DraftCache {
  constructor(private sb: StorageLike, private userId: string) {}
  private path = (jobId: string) => `${this.userId}/drafts/${jobId}.json`;
  async get(jobId: string): Promise<Drafts> {
    const r = await this.sb.storage.from("ingest-files").download(this.path(jobId));
    if (r.error || !r.data) return {};                  // missing object = nothing cached yet
    try { return JSON.parse(await r.data.text()) as Drafts; } catch { return {}; }
  }
  async put(jobId: string, d: Drafts) {
    const r = await this.sb.storage.from("ingest-files").upload(this.path(jobId), Buffer.from(JSON.stringify(d)), { upsert: true, contentType: "application/json" });
    if (r.error) throw new Error(`draft cache write failed: ${r.error.message}`);
  }
}
