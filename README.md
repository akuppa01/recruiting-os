# Recruiting OS

Multi-tenant recruiting automation: job ingestion → scoring → verified-evidence resumes → (dry-run-by-default) applications → company intelligence → outreach → CRM, controlled from a web/mobile dashboard and from Claude via MCP.

- Status and plan: `PROJECT_STATE.md`, `TASKS.md` · Working agreement: `AGENTS.md`
- Architecture: `docs/ARCHITECTURE.md` · API: `docs/API_CONTRACT.md`
- Setup (accounts, secrets): `docs/SETUP.md` · Connect Claude: `docs/MCP_CONNECT.md` · Operate: `RUNBOOK.md`
- Verify: `pnpm install && bash scripts/verify.sh` (prints a truthful pass/fail/skip table)

Safety defaults: `dry_run` mode, `autoApply`/`autoOutreach` off, applications marked `applied` only with confirmation evidence, resumes built only from verified evidence.
