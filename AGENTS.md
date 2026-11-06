# AGENTS.md — Recruiting OS working agreement

Read this first in any new session, then PROJECT_STATE.md, TASKS.md, BLOCKERS.md.

## Hard rules (all agents)
1. Never claim something works until tested. Record what was tested in PROJECT_STATE.md.
2. Never fabricate applications, sent messages, integrations, or success states. An application is `applied` ONLY with confirmation evidence. Every external action records `succeeded | failed | unverified | dry_run`.
3. Default automation mode is `dry_run`. Live mode requires an explicit saved policy per user AND a verified integration.
4. Never invent resume content. Resume text may only be composed from `EvidenceItem`s (verbatim statements). Never invent metrics, titles, dates, degrees.
5. Do not bypass CAPTCHA, auth walls, or platform ToS. Raise an exception (`ExceptionType`) instead.
6. No secrets in Git or logs. Use `.env` (ignored) and `.env.example` (names only). Never ask the user to paste keys into chat.
7. Every table carries `tenant_id` + `user_id` and RLS. Every query takes a `Ctx`.
8. Code against `packages/core` (`domain.ts`, `store.ts`). Do NOT edit those files; request changes via DECISIONS.md "Contract change requests".
9. Commit only your own paths. Small commits, message prefix `[A|B|C|D|E|lead]`. Do not `git add -A`.
10. Blocked? Write to BLOCKERS.md and move to independent work.

## File ownership
| Agent | Owns |
|---|---|
| lead | `packages/core/**`, root config, AGENTS/PROJECT_STATE/TASKS/DECISIONS/BLOCKERS, `.env.example` |
| A  Database & backend | `supabase/**`, `packages/db/**` (SupabaseStore + InMemoryStore + pglite tests), `apps/web/src/app/api/**` |
| B  Discovery & applications | `packages/workers/src/{ingest,normalize,dedupe,score,resume,apply}/**`, `resumes/**` |
| C  Company intel & outreach | `packages/workers/src/{research,proof,contacts,outreach}/**` |
| D  Frontend & mobile | `apps/web/src/app/(app)/**`, `apps/web/src/components/**`, `apps/web/public/**` |
| E  Integrations & QA | `packages/mcp-server/**`, `n8n/**`, `packages/workers/src/{pipeline,notify,gmail}/**`, `tests/**`, `docs/**`, RUNBOOK.md, README.md, `claude-project/**` |

Shared: `packages/workers/src/index.ts` is append-only (export lines only).

## Interfaces
- Store: `packages/core/src/store.ts`. LLM calls go through `packages/workers/src/llm.ts` (`complete(prompt, opts)`), which must work with a stub when `ANTHROPIC_API_KEY` is absent (returns deterministic heuristics tagged `source: "stub"`).
- Pipeline stages: see `JobStage`. Pipeline orchestrator (E) calls stage functions exported by B and C with signature `(store, ctx, jobId) => Promise<void>`.
