// Local long-running Mac worker for the durable task queue. Runs 'apply' tasks (browser work stays on your machine, never on Vercel).
//
//   cd apps/web && ../../node_modules/.bin/tsx scripts/worker.ts                 runs until Ctrl-C (refuses to start while no real handler is wired)
//   cd apps/web && ../../node_modules/.bin/tsx scripts/worker.ts --drain         exits when no task is ready
//   ... --allow-stub     lease tasks even though the apply handler is only the placeholder (each pass pushes them back 15 min and uses an attempt)
//   ... --concurrency 1  parallel tasks (browser work: keep at 1)
//
// Secrets are read from .env.local into process.env and never printed. Task payloads are never logged, only ids and kinds.
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS, type TaskHandler, type TaskKind } from "@ros/core";
import { SupabaseTaskQueue, createServiceClient, createSpendReader } from "@ros/db";
import { NotWiredError, createDefaultHandlers, runWorker, type WorkerEvent } from "../../../packages/workers/src/queue/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|ANTHROPIC_API_KEY)=(.*)$/);
  if (m) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
}

// ---- LEAD: wire the real handler here. It must use the Playwright apply executor, honor the saved policy, never retry an
// uncertain submission (throw NonRetryableError), and call helpers.addCost for any AI spend.
const applyHandler: TaskHandler | undefined = undefined;
// ----

async function main() {
  const stub: TaskHandler = async () => { throw new NotWiredError("apply"); };
  const { handlers, wired } = createDefaultHandlers({ apply: applyHandler ?? stub });
  const reallyWired = applyHandler !== undefined;
  if (!reallyWired && !flag("allow-stub")) {
    console.error("apply handler not wired yet; refusing to lease tasks. (Use --allow-stub to push them back on a delay instead.)");
    process.exit(2);
  }
  const kinds: TaskKind[] = ["apply"];
  const queue = new SupabaseTaskQueue(createServiceClient());
  const workerId = `mac-${hostname().replace(/[^a-z0-9-]/gi, "").slice(0, 20)}-${process.pid}`;
  const ac = new AbortController();
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => { console.log(`\n${s}: finishing the current task, then stopping...`); ac.abort(); });

  const onEvent = (e: WorkerEvent) => {
    const id = "task" in e ? e.task.id.slice(0, 8) : "";
    if (e.type === "task_started") console.log(`▶ ${e.task.kind} ${id} (attempt ${e.task.attempts})`);
    else if (e.type === "task_done") console.log(`✓ ${e.task.kind} ${id} in ${e.seconds.toFixed(1)}s, AI cost $${e.costUsd.toFixed(4)}`);
    else if (e.type === "task_failed") console.log(`✗ ${e.task.kind} ${id} ${e.retry ? "(will retry)" : "(no retry)"}: ${e.error.slice(0, 160)}`);
    else if (e.type === "budget_exceeded") console.log(`$ ${e.task.kind} ${id} stopped by budget (${e.scope})`);
    else if (e.type === "timeout") console.log(`⏱ ${e.task.kind} ${id} exceeded ${e.seconds}s`);
    else if (e.type === "lease_lost") console.log(`! ${e.task.kind} ${id} lease lost; result discarded`);
  };

  console.log(`worker ${workerId} started; kinds=${kinds.join(",")}; wired=${reallyWired ? wired.join(",") : "none (placeholder)"}; ${flag("drain") ? "drain mode" : "Ctrl-C to stop"}`);
  const summary = await runWorker({
    queue, handlers, workerId, kinds, host: hostname(), signal: ac.signal, drain: flag("drain"),
    concurrency: Number(opt("concurrency") ?? 1), leaseSeconds: 180, limits: DEFAULT_LIMITS, spend: createSpendReader(), onEvent,
  });
  console.log("stopped.", JSON.stringify(summary));
}

main().catch((e) => { console.error(`worker stopped: ${e instanceof Error ? e.message : e}`); process.exit(1); });
