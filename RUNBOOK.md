# RUNBOOK.md

(Agent E expands this.) Initial notes:

- Install: `pnpm install`
- Test: `pnpm test` · Typecheck: `pnpm typecheck`
- Modes: `ROS_AUTOMATION_MODE=dry_run` (default) never sends or submits anything.
- Dead-letter queue: ingestions failing 3 attempts move to `dead_letter`; inspect via Notifications & Exceptions page or `select * from dead_letters`.
