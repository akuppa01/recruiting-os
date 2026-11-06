# RUNBOOK

## Everyday
- Install `pnpm install` · verify everything `bash scripts/verify.sh` (truthful pass/fail table).
- Modes: `policy.mode` = `dry_run` (default) or `live`. `autoApply` / `autoOutreach` default **false**.

## Dry-run → live promotion (per user, per capability)
1. Integration connected AND verified (e.g. Gmail: `isVerified()` does a real profile call; Supabase live conformance passes).
2. Run ≥10 real ingestions in dry_run. Review: resume PDFs for factual accuracy (evidence-only), `application.dry_run` events, `external_actions` all `dry_run`.
3. Review the adapter on one real posting with `mode: dry_run` filling the form without submitting (screenshots in application record).
4. Set `policy.autoApply=true` and keep `mode: dry_run` one more day; confirm caps (`maxApplicationsPerDay`).
5. Switch `policy.mode` to `live` via Settings or `update_preferences`. First live application: watch it; confirm the record shows confirmation evidence. An unconfirmed submit becomes `needs_human` + exception, never `applied`.
6. Same sequence for outreach (`autoOutreach`). Roll back instantly by setting `mode: dry_run`.

## Dead-letter queue
A stage that fails 3 attempts (backoff 0.5s, 1s) dead-letters the ingestion: `ingestions.status='dead_letter'`, `error` = `<stage>: <message>`, an exception, a `pipeline.dead_letter` event, and a `dead_letter` notification (n8n "Dead-letter alert" also polls).
- Inspect: Notifications & Exceptions page, or `select id, error, attempts from ingestions where status='dead_letter'`; per-attempt events `stage.<name>.attempt_failed`.
- Fix cause, then re-queue: set the ingestion `status='accepted'` (and clear `error`); the poller picks it up. Pipeline resumes from the job's recorded stage; confirmed applications are never re-submitted (idempotent).
- A claimed ingestion stuck in `processing` after a crash must be reset to `accepted` (stale-claim reaper is not implemented — see PROJECT_STATE).
- Live outreach send failures are marked `failed` and not auto-retried (double-send risk); resend manually after checking the mailbox.

## Verify live Supabase
Set the Supabase env vars, then `pnpm --filter @ros/db test` (live conformance runs only when env is present).

## Incident basics
Stop all automation: set `policy.mode='dry_run'` for the user and deactivate n8n workflows. Rotate any exposed key at its provider, then update env in Vercel/n8n.
