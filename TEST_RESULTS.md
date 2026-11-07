# TEST_RESULTS.md

Only results actually observed. Last updated: 2026-11-07.

## Automated (vitest)
| Suite | Result | Notes |
|---|---|---|
| discovery + qualify (`packages/workers/test/{discovery,qualify}`) | 61/61 pass | Synthetic emails and feed fixtures; no network. |
| apply engine (`packages/workers/test/apply`) | 36/36 pass | 12 existing + 24 new: Greenhouse/Lever/Ashby-style mocks, multipage, upload, validation failure, template reuse, fallback budgets, Tepper-email guard. Mock forms only. |
| durable queue (`packages/db/test/tasks.test.ts`) | 13/13 pass | In-memory implementation, includes concurrent leasing. |
| queue runner (`packages/workers/test/queue`) | 11/11 pass | Retry/backoff, dead-letter, lease loss, graceful stop. |
| Supabase queue live smoke (`tasks.live.test.ts`) | 1/1 pass | Ran against the live project with `zz-test:` keys; tasks, task_logs, worker_heartbeats confirmed empty afterwards. |
| dashboard mapping (`apps/web/test/dashboard.test.ts`) | 13/13 pass | Pure helpers only; UI not viewed in a browser. |
| chief of staff + resolve exception (`apps/web/test/chief.test.ts`) | written, NOT confirmed run | Local runs were too slow when written. |

## Type checking
- The Vercel production build typechecks everything the website imports; all builds since the V1 fixes passed up to commit ae54c16.
- Full `tsc` for `packages/workers` and `apps/web` does not finish on this Mac (disk and CPU); a scoped check of the new V3 modules was started and had not finished. V3 worker modules are therefore tested but NOT type-checked locally.

## Benchmarks (mock forms, `packages/workers/scripts/bench-apply.ts`)
12 scenarios behaved as designed; 6/6 live submits confirmed; mean 0.87 s per completed form; field accuracy 100%; template reuse cut classification calls from 8 to 0; estimated fallback spend about $0.0103 (estimate from prompt size with fake models, not billed). There is no Claude-in-Chrome baseline in the repo, so no old-vs-new comparison exists; do not quote one.

## Real-world checks (by hand, 2026-11-06/07)
- Google sign-in, session persistence, save/open link/mark applied persisted across reload (production).
- Find jobs imported real postings; full-time roles removed and discovery switched to Summer 2027 internships only.
- Greenhouse dry runs filled name, email, phone, resume, LinkedIn, eligibility, education and EEO fields on Anthropic, Databricks and Pinterest.
- Databricks live submit: submit clicked, confirmation not detected, left as unverified (user to check email).
- Pinterest: three dropdowns (availability, degree status, office location) could not be filled by the worker; not submitted.

## 2026-11-07 — cloud dry run with real alert emails (executed, not assumed)
- n8n workflow `Recruiting OS: alert emails -> backend` (Gmail -> batch -> POST /api/internal/gmail-sync): manual execution succeeded; 51 emails (40 from 12twenty, 9 Handshake, 2 LinkedIn) became 51 `discover` tasks. Workflow is now published (every 3 hours).
- GitHub Actions cloud worker (dry run, no Mac): discovery 127 found / 98 new / 0 failed; 140 jobs in Supabase (36 scored for review, 6 qualified, 81 archived by rules); 84 carry deadlines.
- Bug found and fixed by this run: unresolved 12twenty tracking links all canonicalized to one URL and collapsed ~100 jobs into one (30 found instead of 127). Regression test: `packages/workers/test/discovery/tracking-links.test.ts`.
- Parser on the real stored emails: 99 distinct 12twenty jobs + 20 Handshake round-up jobs; discovery tests 52/52 plus 13 in the health/run + tracking suites.
- Bot-protected careers pages (Rubrik: Akamai "Access Denied"; Pinterest: Cloudflare Turnstile) are reported as `platform_restricts_automation`; never bypassed.
- Live app after build 33d70c4: manifest, service worker and 3 PNG icons return 200 without login; /api/* is 401 without the secret.
- NOT tested: a confirmed live submission with evidence (Databricks is unverified); dashboard visual check at phone width (needs the user's Google sign-in); Lever/Ashby live submit.
