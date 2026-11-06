# LIVE_VERIFICATION.md

This file tracks every verification check for the live-setup phases (Prompt 2).
Updated in-place after each check. Status values: **untested** / **pass** / **fail** / **blocked** / **user-action-needed**.

---

## Phase 0: Sanity (local demo mode)

| # | Check | Status | Date | Evidence |
|---|-------|--------|------|----------|
| 0.1 | `pnpm install --frozen-lockfile` | **pass** | 2026-11-06 | Completed in 30.8s via `npx pnpm` (pnpm v10.28.0 installed via corepack/npx) |
| 0.2 | Typecheck: all 6 packages (`@ros/core`, `@ros/db`, `@ros/workers`, `@ros/mcp-server`, `@ros/e2e`, `@ros/web`) | **pass** | 2026-11-06 | All exit 0 via `node_modules/.bin/tsc --noEmit`; pnpm wrapper also completed 0 (backgrounded) |
| 0.3 | Tests: all packages | **pass** | 2026-11-06 | 301 passed, 12 skipped (live Supabase), 1 file skipped (supabase.test.ts) — Playwright Chromium installed first (`chromium_headless_shell-1254`) |
| 0.4 | `next build` | **pass** | 2026-11-06 | 14 routes emitted, no errors |

---

## Phase A: Supabase

| # | Check | Status | Date | Evidence |
|---|-------|--------|------|----------|
| A.1 | List tables, RLS, buckets, extensions, functions — confirm migration state | **untested** | – | Needs Supabase MCP authenticated |
| A.2 | 20 tables exist, RLS on all, `bootstrap_tenant()` exists, buckets `resumes`+`ingest-files` private, storage policies exist | **untested** | – | Depends on A.1 |
| A.3 | Security/performance advisors run; real issues fixed | **untested** | – | – |
| A.4 | Cross-tenant RLS test script against real Supabase; test users created, isolation proved, users deleted | **untested** | – | Script: `scripts/test-rls-live.mjs` |
| A.5 | Google Auth provider configured; sign-in flow verified end to end | **user-action-needed** | – | User must configure in Supabase dashboard + Google Cloud console; exact steps provided below |

---

## Phase B: Local run against live Supabase

| # | Check | Status | Date | Evidence |
|---|-------|--------|------|----------|
| B.1 | `.env.local` has all required vars | **untested** | – | – |
| B.2 | App runs locally with live Supabase + `ROS_AUTOMATION_MODE=dry_run` | **untested** | – | – |
| B.3 | Google sign-in creates tenant (first login) and is idempotent (second login) | **untested** | – | Depends on A.5 |
| B.4 | Evidence bank imported into `evidence_items` (32 usable, 5 quarantined) | **untested** | – | Script: `scripts/import-evidence-to-supabase.mjs` |
| B.5 | 3 real JDs ingested, normalized, scored, tailored; DB rows confirmed | **untested** | – | Needs JDs from user (samples/jds/ is empty) |
| B.6 | Negative tests (no company name, empty paste, dedupe, no auth, bad token, quarantined evidence, prompt injection) | **untested** | – | – |
| B.7 | Live Anthropic call: stub replaced when key set, token/cost per ingest, failures degrade to `needs_human` | **untested** | – | – |

---

## Phase C: Resume output

| # | Check | Status | Date | Evidence |
|---|-------|--------|------|----------|
| C.1 | Tailoring starts from child resumes; Tepper format; 1 PDF per archetype generated from real JD | **untested** | – | – |
| C.2 | Test: fail if output contains yellow/Hold/unconfirmed content, or any bullet without evidence id | **untested** | – | – |
| C.3 | PDF one-page check (page count ≤ 1) | **untested** | – | – |
| C.4 | PDF plain-text extraction check (ATS-readable) | **untested** | – | – |

---

## Phase D: Vercel

| # | Check | Status | Date | Evidence |
|---|-------|--------|------|----------|
| D.1 | Vercel project linked to GitHub repo for auto-deploy | **untested** | – | – |
| D.2 | All required env vars in Vercel (names confirmed, values not printed) | **untested** | – | – |
| D.3 | Deploy succeeds; sign-in works on deployed URL | **untested** | – | Depends on SSO bypass approval |
| D.4 | Ingest end to end on deployed URL; bearer token rejects bad tokens | **untested** | – | – |
| D.5 | Runtime logs clean; no secrets in logs or client bundle | **untested** | – | – |
| D.6 | Durable pipeline (cron or n8n) decision + implementation + test | **untested** | – | – |

---

## Phase E: MCP server

| # | Check | Status | Date | Evidence |
|---|-------|--------|------|----------|
| E.1 | MCP server runs locally against live API; all 10 tools exercised | **untested** | – | – |
| E.2 | Tools with missing backend return honest "not implemented" (not fake data) | **untested** | – | – |
| E.3 | Steps to add MCP server to Claude Project + instruction file finalized | **untested** | – | – |

---

## Phase F: Post-approval only

| # | Check | Status | Date | Evidence |
|---|-------|--------|------|----------|
| F.1 | Gmail OAuth send-only; first draft to self | **untested** | – | Requires user go-ahead |
| F.2 | n8n workflows imported and executed once with test data | **untested** | – | Requires user go-ahead |
| F.3 | Apollo + Snov enrichment: 1 lookup each, credit usage recorded | **untested** | – | Requires user go-ahead |
| F.4 | Push notification: 1 test to phone | **untested** | – | Requires user go-ahead |
