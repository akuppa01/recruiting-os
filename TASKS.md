# TASKS.md — master plan (owner · status · deps · acceptance)

Status: TODO / DOING / DONE / BLOCKED. Update in place; do not delete rows.

## Phase 1 — vertical slice (ingest → normalize → dedupe → score → CRM row → visible in UI/MCP)
| ID | Task | Owner | Status | Deps | Acceptance |
|----|------|-------|--------|------|-----------|
| L1 | Repo, contracts (`packages/core`), state files | lead | DONE | – | typecheck passes |
| A1 | Supabase migrations: tenancy, jobs, ingestions, applications, resumes, companies, contacts, outreach, events, exceptions, DLQ, usage/cost, feature flags | A | DONE — 0001_core.sql + 0002_storage.sql apply cleanly on pglite (tested; NOT yet applied to a real Supabase project) | L1 | applies cleanly on pglite/Postgres in test |
| A2 | RLS policies + cross-tenant isolation tests | A | DONE — 120 pglite tests: B cannot select/insert/update/delete A's rows on all 18 tables + storage; spoofed user_id rejected (tested on pglite, not live Supabase) | A1 | test proves user B cannot read/write user A rows |
| A3 | `InMemoryStore` + `SupabaseStore` implementing `Store` | A | DONE (InMemory) / UNVERIFIED (Supabase) — conformance suite 12/12 on InMemoryStore; SupabaseStore typechecks, live suite skipped (no creds) | L1 | shared conformance test suite passes on both (Supabase one skipped w/o creds) |
| A4 | `POST /api/ingest` (URL/text/file/structured), returns ingestionId immediately, idempotent | A | DONE — route tests 19/19 (accept, idempotent, validation, enqueue hook ok/fail/hang, auth, read endpoints, prefs, live-mode guard) | A3 | route test: 202-style accept, duplicate key returns same ID |
| B1 | normalize + dedupe + ATS URL detection | B | TODO | L1 | unit tests on Greenhouse/Lever/Ashby URLs and messy text |
| B2 | scoring engine against Preferences | B | TODO | B1 | unit tests incl. hard rejects |
| E1 | pipeline orchestrator (stage runner, retries, DLQ) | E | TODO | A3,B1,B2 | e2e test with InMemoryStore |
| D1 | app shell + Command Center + Pipeline + quick-ingest | D | DONE (demo data; swap `apps/web/src/lib/data.ts` to `getStore()`) | L1 | `next build` passes; works against demo store |
## Phase 2 — discovery connectors, evidence bank, resumes
| B3 | Evidence bank loader + 4 archetypes + tailoring (evidence-only) + ATS PDF | B | TODO | L1 | factual-confidence check rejects any unverifiable line |
| B4 | Public ATS feed connectors (Greenhouse/Lever/Ashby JSON) | B | TODO | B1 | parses recorded fixtures |
| E2 | Gmail alert parser, CSV/Sheet ingest, WhatsApp export parser | E | TODO | A4 | fixture tests |
## Phase 3 — application automation
| B5 | Adapters Greenhouse/Lever/Ashby via Playwright, dry-run default, confirmation verification, idempotency | B | TODO | B3 | dry-run test on fixture form; no live submit without policy |
## Phase 4 — intelligence & outreach
| C1 | Company research worker (+ labeled speculation) | C | DONE | L1 | output schema validated; sources recorded |
| C2 | Proof-of-work template + deployable preview + Loom script | C | DONE | C1 | renders for sample company |
| C3 | Contact discovery/ranking (provider-agnostic) | C | DONE | C1 | ranking unit tests |
| C4 | Outreach sequences, follow-ups, reply/opt-out suppression | C | DONE | C3 | suppression tests |
## Phase 5 — mobile, push, conversational control
| E3 | MCP server with 10 tools + Claude Project instruction file | E | TODO | A4 | tool contract tests |
| E4 | Push notifications (ntfy/Pushover/web push adapter) | E | TODO | E1 | dry-run adapter tested |
| D2 | remaining pages (11 total), exceptions queue, AI chief-of-staff chat | D | DONE for UI; needs /api/chief-of-staff, /api/exceptions/:id/resolve, /api/resume | D1 | all routes build |
## Phase 6 — reliability & productization
| E5 | n8n workflows (export JSON), retry/DLQ docs, monitoring | E | TODO | E1 | JSON validates |
| A5 | export/deletion, usage metering, cost tracking, feature flags | A | DONE (in-memory tested) — packages/db/src/admin.ts usage metering, flags, export, delete; SupabaseAdmin typechecks only | A3 | tests |
| D3 | onboarding wizard | D | DONE for UI; save needs auth + /api/resume | D2 | route builds |
