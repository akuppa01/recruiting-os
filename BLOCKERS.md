# BLOCKERS.md

| ID | Blocker | Needs | Status |
|----|---------|-------|--------|
| B-001 | No live Supabase project | You create project; add URL/keys to `.env.local` + Vercel (see RUNBOOK) | RESOLVED 2026-11-06: project `xsrnhlouwndlmhccwoyr` live; all keys in `.env.local` |
| B-002 | No Anthropic API key in workspace | You add `ANTHROPIC_API_KEY` to `.env.local`/Vercel | RESOLVED 2026-11-06: key set in `.env.local` |
| B-003 | Resume evidence bank | Real items needed in `resumes/evidence/private/*.json` (git-ignored). Then run `node scripts/import-evidence-to-supabase.mjs`. Previously noted 32 verified items — private directory was lost (git-ignored; not committed). Re-supply items to unblock B.4. | OPEN |
| B-004 | Gmail OAuth | Google Cloud OAuth client, consent screen. Steps in LIVE_VERIFICATION.md A.5. | OPEN |
| B-005 | Vercel / n8n hosting accounts | Vercel login; n8n cloud or self-host | OPEN |
| B-006 | macOS Spotlight mass-indexes pnpm store | `pkill -9 mdworker mdbulkimport` before each dev server start. Permanent fix: add repo root to Spotlight Privacy in System Settings → Siri & Spotlight → Privacy. Created `.metadata_never_index` files in `node_modules/` as partial mitigation. | OPEN (recurring — mitigated) |
