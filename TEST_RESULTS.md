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
