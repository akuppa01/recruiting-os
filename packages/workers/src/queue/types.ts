import type { Ctx, PipelineLimits, Task, TaskHandler, TaskHandlerHelpers, TaskKind, TaskQueue } from "@ros/core";

export type HandlerRegistry = Partial<Record<TaskKind, TaskHandler>>;

/** Reads AI/browser spend for a user since a point in time (backed by the usage_events table). */
export interface SpendReader { spentUsd(ctx: Ctx, since: Date): Promise<number> }

/** Helpers every handler receives. `aiAllowed`/`taskCostUsd` are extras beyond the core TaskHandlerHelpers contract. */
export interface WorkerHelpers extends TaskHandlerHelpers {
  /** False once the user's daily or monthly AI budget is spent: handlers must then stay deterministic. */
  aiAllowed(): boolean;
  taskCostUsd(): number;
}

/** Failure that must not be retried (bad input, unsupported site, uncertain submission, handler not wired). */
export class NonRetryableError extends Error { constructor(message: string) { super(message); this.name = "NonRetryableError"; } }
/** A handler for this kind is a placeholder: the task is pushed back with a long delay instead of failing hard. */
export class NotWiredError extends Error { constructor(kind: string) { super(`${kind} handler not wired yet`); this.name = "NotWiredError"; } }
export class BudgetExceededError extends Error {
  constructor(readonly scope: "daily" | "monthly" | "per_application", message: string) { super(`budget_exceeded:${scope}: ${message}`); this.name = "BudgetExceededError"; }
}
export class TaskTimeoutError extends Error { constructor(seconds: number) { super(`timeout: exceeded ${seconds}s`); this.name = "TaskTimeoutError"; } }

export type WorkerEvent =
  | { type: "task_started"; task: Task }
  | { type: "task_done"; task: Task; seconds: number; costUsd: number }
  | { type: "task_failed"; task: Task; error: string; retry: boolean }
  | { type: "lease_lost"; task: Task }
  | { type: "budget_exceeded"; task: Task; scope: "daily" | "monthly" | "per_application"; detail: string }
  | { type: "timeout"; task: Task; seconds: number };

export interface RunWorkerOptions {
  queue: TaskQueue;
  handlers: HandlerRegistry;
  workerId: string;
  /** Defaults to every kind that has a handler. Tasks of other kinds are left untouched in the queue. */
  kinds?: TaskKind[];
  concurrency?: number;
  leaseSeconds?: number;
  heartbeatMs?: number;
  pollMs?: number;
  limits?: PipelineLimits;
  spend?: SpendReader;
  /** Kinds whose wall-clock time is capped by limits.maxBrowserSeconds. Default: apply, verify. */
  browserKinds?: TaskKind[];
  /** Kinds that must never be blindly retried after a timeout or uncertain outcome. Default: apply. */
  noBlindRetryKinds?: TaskKind[];
  /** Exit when no task is ready and nothing is running (instead of polling forever). */
  drain?: boolean;
  signal?: AbortSignal;
  host?: string;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onEvent?: (e: WorkerEvent) => void;
}

export interface WorkerSummary { leased: number; done: number; failed: number; retried: number; leaseLost: number; budgetSkips: number; timeouts: number }
