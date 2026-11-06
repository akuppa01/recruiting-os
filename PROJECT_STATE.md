# PROJECT_STATE.md

Last updated: 2026-11-06 (lead, cycle 1 start)

## What actually works (tested)
- Repo skeleton + shared contracts in `packages/core` (typecheck: see below once run).

## Tested
- (nothing yet)

## Incomplete
- Everything else. See TASKS.md.

## Needs from user
See BLOCKERS.md.

## Next
Spawn agents A–E against the contracts; integrate; run vertical slice.

## Resume instructions for a new session
1. `cd recruiting-os && git log --oneline | head -20`
2. Read AGENTS.md, TASKS.md, BLOCKERS.md, DECISIONS.md.
3. `pnpm install && pnpm typecheck && pnpm test`

## Agent C (company intelligence & outreach) — cycle 1
Code: `packages/workers/src/{research,proof,contacts,outreach}/`; tests in `packages/workers/test/{research,proof,contacts,outreach,agentC.integration}.test.ts` (+ `fakeStore.ts` helper).
**Works and tested** (typecheck clean; 37 Agent C tests green, incl. one end-to-end on `@ros/db` InMemoryStore):
- `researchCompany` / `runResearchStage`: zod `CompanyResearch`; every claim `sourced|inference|speculation`; sourced requires a cited page that was actually fetched (LLM claims citing unfetched URLs are downgraded to speculation). Stub path (no key) is page-derived + labelled speculation, `source:"stub"`. Moves stage normalized -> researched.
- Proof page: self-contained HTML, every claim badged, HTML-escaped, illustrative metrics only when supplied and labelled, public-source footer, `noindex`. Loom script generator. `VercelAdapter`: `dry_run` without `VERCEL_TOKEN`; with it, a parsed URL is only `unverified` until `verifyUrl` gets a 200; never fabricates a URL.
- Contacts: `rankContacts` (weights documented in `rank.ts`), Apollo/Snov/Manual-CSV providers, `discoverContacts` (skips unconfigured providers and reports them; persists via Store).
- Outreach: planner (quiet hours, follow-up days), evidence-only drafter (verbatim statements, refuses empty evidence, opt-out line), reply/opt-out/rejection/bounce classifier -> `suppressContact`, sender seam (live only if policy live + autoOutreach + verified), `runOutreachTick` (idempotent, caps, quiet hours, follow-ups only after prior step went out), LinkedIn/X as manual exception tasks.
**NOT verified / incomplete:**
- Apollo and Snov adapters were written from official docs but never called live (no keys). Apollo response person fields were not visible in the docs fetched; parsing is defensive. Neither fetches emails automatically (credit spend); Apollo people search returns no emails by design, so email enrichment (`people/match`) is not implemented.
- `GmailSender` (googleapis) is untested against real Gmail; reply polling (`checkInbound`) has no Gmail implementation yet (interface only; Agent E's Gmail connector could provide it).
- Research LLM path is tested only with a mocked `complete`; no real Anthropic call was made. No web search: research uses only the company's own public pages (home/about/careers/blog/news), so news/competitors/market are empty in stub mode.
- Tick does not auto-retry failed live sends (avoids double-send); a crash between send and the status update could cause a duplicate on rerun. Gmail has no idempotency key.
- Pipeline wiring (call `runResearchStage`, `discoverContacts`, `scheduleSequence`, `runOutreachTick`) is Agent E's; the tick needs a `lookupContact` dep because `Store` has no `getContact`.

## Agent D (frontend, 2026-11-06)
Working: 11 pages + /more (mobile menu) + /onboarding, responsive shell (sidebar / bottom tab bar), light/dark, DEMO banner, PWA manifest + icon, `public/sw.js` push stub (UNVERIFIED: no VAPID keys, no subscribe flow).
Data: pages read ONLY through `apps/web/src/lib/data.ts`, which returns fictional demo rows when `NEXT_PUBLIC_SUPABASE_URL` is unset and EMPTY lists otherwise (empty states shown, no fake numbers). Not yet wired to `getStore()`.
Tested: `pnpm --filter @ros/web typecheck` and `build` pass (including Agent A's /api routes after adding a webpack `.js`->`.ts` extension alias in next.config.mjs); `next start` returns 200 for all 13 routes + manifest/sw/icon; Playwright screenshots at 1280px and 390px, light and dark, viewed; quick-ingest in a real browser against A's /api/ingest shows the honest "not signed in" error on 401; onboarding live-mode warning renders.
Not done / needs others: no real sign-in UI (A exposes `setSessionResolver` for @supabase/ssr cookies); POSTs to /api/chief-of-staff (E), /api/exceptions/:id/resolve, /api/resume and PUT /api/preferences are called but not verified end-to-end (preferences exists from A; others absent); analytics are computed from data.ts rows only; integration "Configured" = env vars present, not a tested connection; no automated UI tests; accessibility checked by structure only (no axe run).

## Agent A (database & backend) — 2026-11-06
**Works + tested** (`pnpm --filter @ros/db test`: 138 passed, 12 skipped; `pnpm --filter @ros/web test` api.test: 19 passed; both typecheck clean):
- `InMemoryStore` passes the 12-case `Store` conformance suite (`packages/db/test/conformance.ts`): idempotent ingestion, per-tenant dedupe -> `duplicate`, one application per tenant+job (also under concurrent calls), no `confirmed` without evidence, `suppressContact` stops draft/scheduled outreach but not sent, tenant isolation, event log, dry_run default prefs.
- Migrations `supabase/migrations/0001_core.sql`, `0002_storage.sql`: 20 tables incl. tenants/members, jobs, applications (unique tenant+job; DB check: confirmed requires evidence), dead_letters, external_actions, usage_events, feature_flags, hashed api_tokens, private storage buckets. RLS on every table. `bootstrap_tenant()` onboarding function.
- RLS isolation proven on **pglite** (real Postgres in WASM, `auth.uid()` shimmed via a session setting): 120 tests.
- API (`apps/web/src/app/api/**`, logic in `apps/web/src/lib/handlers.ts`): POST /api/ingest (202, id returned immediately, idempotent via body key or `Idempotency-Key`), GET /api/ingest/[id], /api/pipeline, /api/jobs, /api/jobs/[id], GET/PUT /api/preferences (deep-merge; switching to live needs `confirmLive:true`), GET /api/exceptions.
- Auth: bearer token -> sha256 -> `api_tokens`, or Supabase JWT; demo mode (no Supabase env) uses `ROS_API_TOKEN`, open only when unset AND not production. `setSessionResolver()` hook for D's cookie sessions.
- `enqueue.ts` hook: **Agent E must call `setEnqueue(fn)`**. Without it, ingestions stay `accepted` and the worker poller (`store.claimIngestions`) must pick them up. A failing/hung hook never fails the request (1.5s cap, event logged).
- `getStore()`/`getStoreAsync()`: SupabaseStore when env present, else seeded in-memory demo (responses carry `x-ros-demo: 1`; data not persisted).
- `packages/db/src/admin.ts`: usage metering, `recordLlmUsage` (no built-in price table; cost 0 unless caller supplies pricing), feature flags (risky automation default off), user data export (no token hashes) and deletion (requires `confirm === userId`).

**NOT verified / incomplete**
- Nothing has run against a real Supabase project (BLOCKERS B-001). `SupabaseStore`, `SupabaseAdmin`, token lookup and JWT session resolution typecheck only. `test/supabase.test.ts` is skipped without env; to run it live set `ROS_TEST_TENANTS_PROVISIONED=1` after provisioning auth.users rows for the random ids (or adapt it to use real test users).
- Applying migrations to hosted Supabase (`supabase db push`) is a user step.
- No browser-cookie session auth yet (only bearer JWT + resolver hook). No rate limiting. File upload (`fileRef`) is stored as a reference only; no upload endpoint.
- RLS tests use shims for `auth`/`storage`; real Supabase storage policy behavior is unverified.

## Agent B (discovery & applications) — 2026-11-06
Code: `packages/workers/src/{normalize,score,stages,connectors,resume,apply}`, `resumes/evidence`. 125/125 workers tests pass (all agents' suites), `tsc` clean.

**Working + tested**
- normalize: ATS detection (Greenhouse both hosts, Lever, Ashby, `gh_jid` career pages, Workday/iCIMS/SmartRecruiters detected only), pasted-JD extraction (title/company/location/salary/deadline/internship/MBA/Summer-2027), structured input, sha256 `dedupeKey` (ATS id when known, else normalized company|title|location). Unknowns stay null; nothing guessed.
- score: weighted by `Preferences.weights` + `roleOrder`; hard rejects (not internship, wrong season, undergrad-only, excluded company/location, pay below min) -> archive; unknown role -> archive; borderline -> needs_review. Each reject has a test.
- stages: `runNormalizeStage`, `runScoreStage` verified on both a local fake and Agent A's `InMemoryStore` (duplicates become a `duplicate` row and are skipped by scoring; borderline raises an exception).
- connectors: Greenhouse/Lever/Ashby parsers; field names checked against official docs (corrections applied: Greenhouse list has no `company_name`/`first_published`). Tested ONLY on documentation-derived fixtures (`test/fixtures/*.doc-derived.json`). `fetchFeed` was never called against a live API.
- resume: evidence loader (refuses `*.synthetic.json`), 4 archetypes + selector, verbatim tailoring, verifier (numbers, proper nouns/titles, word traceability, header drift), optional `rephraseBullets` that falls back to verbatim on any failed check, single-column pdfkit PDF, `runResumeStage` (raises `missing_profile_field` when bank empty, `low_factual_confidence` on failure). Adversarial tests pass (fabricated 12 teams / 90% / Google / Director / $5M / 340% all rejected).
- apply: Playwright (real headless Chromium installed in `/opt/pw-browsers`) against local fixture forms: dry-run fills and never submits (server-side hit counter = 0); live only when `mode=live && autoApply && adapter in verifiedAdapters` (default empty set); confirmation requires positive text evidence; unverified submits are never marked applied and are never retried; CAPTCHA / auth wall / required sensitive-eligibility / unknown required field -> exception, no bypass; optional EEO fields left blank; idempotent via `getOrCreateApplication`.

**Not done / caveats**
- Evidence bank is EMPTY (B-003): real tailoring cannot run until the user supplies resume/supporting docs. Only synthetic data was used in tests.
- No adapter has been exercised on a real Greenhouse/Lever/Ashby page; selectors and confirmation patterns are best-effort and therefore every adapter is unverified. Live submission is off by design.
- No daily application cap enforcement (`maxApplicationsPerDay`): `Store` has no count method; pipeline (E) should enforce.
- Cover letter generation, pasted-file/PDF text extraction (`fileRef`), LLM-assisted extraction, and Workday/iCIMS adapters are not implemented. Salary is stored as given (hourly if < 500) rather than annualized.
- Shared-file note: I created `src/llm.ts` while another agent's version may have existed (untracked, so unrecoverable); mine follows the contract. `test/fakeStore.ts` (Agent C) was briefly overwritten and restored from git.
