import { z } from "zod";
import { IngestRequest, IngestSource, JobStage, Preferences } from "@ros/core";
import type { RosClient } from "./client.js";

export interface ToolDef { name: string; title: string; description: string; shape: z.ZodRawShape; readOnly: boolean; run: (c: RosClient, a: any) => Promise<unknown> }

export const tools: ToolDef[] = [
  {
    name: "add_job", title: "Add job to Recruiting OS", readOnly: false,
    description: "Send a job link, pasted job description, or structured job to the ingestion endpoint. Returns a persistent ingestionId immediately; the pipeline runs asynchronously. Use get_pipeline/search_jobs later for results.",
    shape: { url: z.string().url().optional(), text: z.string().optional(), note: z.string().optional(), source: IngestSource.optional(), idempotencyKey: z.string().optional() },
    run: (c, a) => {
      if (!a.url && !a.text) throw new Error("Provide url or text");
      const body = IngestRequest.parse({ source: a.source ?? (a.url ? "mcp" : "mcp"), url: a.url, text: a.text, note: a.note, idempotencyKey: a.idempotencyKey });
      return c.call("POST", "/api/ingest", { body });
    },
  },
  {
    name: "search_jobs", title: "Search jobs", readOnly: true,
    description: "Search jobs in the database by text, stage, and minimum score.",
    shape: { text: z.string().optional(), stage: JobStage.optional(), minScore: z.number().min(0).max(100).optional(), limit: z.number().int().min(1).max(100).optional() },
    run: (c, a) => c.call("GET", "/api/jobs", { query: { q: a.text, stage: a.stage, minScore: a.minScore, limit: a.limit } }),
  },
  { name: "get_pipeline", title: "Get pipeline", readOnly: true, description: "Counts of jobs per stage plus open exceptions.", shape: {}, run: (c) => c.call("GET", "/api/pipeline") },
  {
    name: "get_company", title: "Get company", readOnly: true,
    description: "Company record, stored research (labelled facts vs speculation), and contacts.",
    shape: { name: z.string().min(1) }, run: (c, a) => c.call("GET", "/api/companies", { query: { name: a.name } }),
  },
  {
    name: "get_application_status", title: "Get application status", readOnly: true,
    description: "Application status for a job. 'applied' means submission was confirmed with evidence; otherwise status explains dry_run/unverified/failed.",
    shape: { jobId: z.string().uuid() }, run: (c, a) => c.call("GET", "/api/applications", { query: { jobId: a.jobId } }),
  },
  {
    name: "update_preferences", title: "Update preferences", readOnly: false,
    description: "Patch recruiting preferences and automation policy. Switching policy.mode to 'live' is allowed only through this explicit call.",
    shape: { patch: z.record(z.unknown()) },
    run: (c, a) => c.call("PATCH", "/api/preferences", { body: Preferences.partial().parse(a.patch) }),
  },
  {
    name: "run_company_research", title: "Run company research", readOnly: false,
    description: "Queue company research (product, strategy, news, competitors, hiring context). Returns a task/ID; read results via get_company.",
    shape: { company: z.string().min(1), jobId: z.string().uuid().optional() }, run: (c, a) => c.call("POST", "/api/companies/research", { body: a }),
  },
  {
    name: "generate_proof_of_work", title: "Generate proof-of-work", readOnly: false,
    description: "Queue a company-specific proof-of-work asset (dashboard preview + Loom script). Speculative analysis is labelled as such.",
    shape: { company: z.string().min(1), jobId: z.string().uuid().optional() }, run: (c, a) => c.call("POST", "/api/proof-of-work", { body: a }),
  },
  {
    name: "get_outreach_status", title: "Get outreach status", readOnly: true,
    description: "Outreach messages, statuses (draft/scheduled/sent/dry_run/stopped) and suppression reasons.",
    shape: { jobId: z.string().uuid().optional(), contactId: z.string().uuid().optional() },
    run: (c, a) => c.call("GET", "/api/outreach", { query: a }),
  },
  {
    name: "ask_recruiting_chief_of_staff", title: "Ask Chief of Staff", readOnly: true,
    description: "Ask a question answered from database state (pipeline, exceptions, activity). Answers cite stored records.",
    shape: { question: z.string().min(1) }, run: (c, a) => c.call("POST", "/api/chief-of-staff", { body: { question: a.question } }),
  },
];
