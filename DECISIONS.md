# DECISIONS.md

## D-001 Store interface as the parallelism seam (2026-11-06)
Workers, MCP server and UI depend only on `Store` in `packages/core`. Agent A provides `InMemoryStore` (tests/demo) and `SupabaseStore`. Lets five agents build concurrently with no live DB.

## D-002 pglite for migration/RLS tests (2026-11-06)
No local Supabase in the cloud workspace; use `@electric-sql/pglite` to run migrations and prove RLS. Live Supabase verification is a user-setup step (BLOCKERS B-001).

## D-003 Dry-run default (2026-11-06)
`AutomationPolicy.mode` defaults `dry_run`, `autoApply`/`autoOutreach` default false. Going live is a deliberate per-user setting after an integration is verified. Matches your instruction to use dry-run until verified.

## D-004 LLM stub (2026-11-06)
All LLM use goes through `llm.ts` with deterministic stub when no `ANTHROPIC_API_KEY`, so everything is testable offline and outputs are tagged `source: "stub"|"anthropic"`.

## D-005 Outreach channel scope (2026-11-06)
Automated sends: Gmail (user's authorized mailbox) only. LinkedIn/X: generate drafts + manual-send exception tasks; no scraping or automated messaging (platform ToS).

## Contract change requests
(append below: `CR-n by <agent>: <what/why>`)
