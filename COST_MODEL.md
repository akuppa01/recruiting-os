# COST_MODEL.md

Principle: deterministic code first; small model only when needed; big model almost never.

| Tier | Used for | Cost today |
|---|---|---|
| 0: code (TypeScript, SQL, Playwright) | feeds, parsing, dedupe, qualification, form fill from saved answers and form templates, queue, scheduling | $0 (runs on the user's Mac and Vercel) |
| 1: small model (Haiku via `llm.ts`, `ROS_ESSAY_MODEL`) | free-text essay drafts (numbers must trace to the resume), interpreting an unfamiliar question | cents per essay; not metered yet |
| 2: larger model | company research / proof-of-work only, when explicitly triggered | not used in V3 |
| Browser | local Playwright on the Mac | $0; no paid cloud browser added |

Limits defined in `packages/core/src/v3.ts` (`DEFAULT_LIMITS`): $2/day AI, $30/month AI, $0.15 per application, 2 fallback attempts, 300 s browser time. The queue runner enforces them from `usage_events` via an injected spend reader; the spend reader is NOT yet wired to production data, so the caps are not active in live paths.

Measured/estimated: mock-form fallback scenarios about $0.0103 total (estimate, fake models). Real per-application cost is not measured yet.
