# BLOCKERS.md

| ID | Blocker | Needs | Status |
|----|---------|-------|--------|
| B-001 | No live Supabase project | You create project; add URL/keys to `.env.local` + Vercel (see RUNBOOK) | RESOLVED 2026-11-06: project `xsrnhlouwndlmhccwoyr` live; all keys in `.env.local` |
| B-002 | No Anthropic API key in workspace | You add `ANTHROPIC_API_KEY` to `.env.local`/Vercel | RESOLVED 2026-11-06: key set in `.env.local` |
| B-003 | Resume evidence bank | Real items needed in `resumes/evidence/private/*.json` (git-ignored). Then run `node scripts/import-evidence-to-supabase.mjs`. Previously noted 32 verified items — private directory was lost (git-ignored; not committed). Re-supply items to unblock B.4. | OPEN |
| B-004 | Gmail OAuth | Google Cloud OAuth client, consent screen. Steps in LIVE_VERIFICATION.md A.5. | OPEN |
| B-005 | Vercel / n8n hosting accounts | Vercel login; n8n cloud or self-host | OPEN |
| B-006 | macOS Spotlight mass-indexes pnpm store | `pkill -9 mdworker mdbulkimport` before each dev server start. Permanent fix: add repo root to Spotlight Privacy in System Settings → Siri & Spotlight → Privacy. Created `.metadata_never_index` files in `node_modules/` as partial mitigation. | OPEN (recurring — mitigated) |

## V3 (2026-11-07)
| ID | Blocker | Needs | Status |
|----|---------|-------|--------|
| B-007 | n8n has no Gmail credential | User: n8n → Credentials → Gmail OAuth2 → sign in as akuppa@tepper.cmu.edu (read-only). If CMU blocks third-party apps, forward alerts to a personal Gmail instead. | OPEN |
| B-008 | n8n has no header credential for the batch endpoints | User: n8n Header Auth credential `Authorization: Bearer <CRON_SECRET>` (value is already in Vercel; enter it in n8n yourself) | OPEN |
| B-009 | Job-alert emails not enabled on Handshake / 12twenty / LinkedIn / Indeed | User: turn on saved-search alerts to the Tepper address | OPEN |
| B-010 | Local `tsc` cannot finish on this Mac | Free disk space; until then Vercel build is the only full typecheck | OPEN (B-006 related) |
| B-011 | Apply/discover handlers not wired to the durable queue | Lead: finish wiring in `apps/web/scripts/worker.ts` | OPEN |
| B-012 | Pinterest dropdowns (availability, degree status, office location) not fillable by the worker | Needs their option text; worker now reports options in the exception | OPEN |
| B-013 | Databricks submission unverified | User: check Tepper/business inbox for a Databricks confirmation email | OPEN |
| B-014 | 12twenty job links are click-tracking redirects; the cloud worker cannot find the real ATS URL, so email jobs are listed for review but not auto-applied | Mac worker or a redirect-resolving step on a residential IP; or user applies from the dashboard link | OPEN |
| B-015 | Rubrik (Akamai) and Pinterest (Cloudflare) block datacenter IPs | Run those on the Mac worker (residential IP) or apply by hand; not evaded | OPEN |
| B-016 | Gmail credential account unconfirmed (akuppa@ vs ekuppa@tepper.cmu.edu) | User: confirm which address n8n is signed into | OPEN |
