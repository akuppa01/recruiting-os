import { describe, expect, it } from "vitest";
import {
  PHASES, derivePhase, estimateN8nExecutions, exceptionJobId, mergeLimits, nextAction, nextRetryKey, phaseCounts, queueDepth,
  retryEligibility, sourceLabel, sourceTone, spendStatus, successRate, summarizeApplyStats, summarizeBrowserRuns, summarizeRun,
  summarizeUsage, workerStatus,
} from "../src/lib/pipeline-view";

describe("lifecycle phases", () => {
  it("is DISCOVER -> QUALIFY -> TAILOR -> APPLY -> SUBMITTED -> FOLLOW_UP", () => {
    expect([...PHASES]).toEqual(["DISCOVER", "QUALIFY", "TAILOR", "APPLY", "SUBMITTED", "FOLLOW_UP"]);
  });
});

describe("derivePhase", () => {
  it("maps job stage and tracking to lifecycle phases", () => {
    expect(derivePhase({ stage: "normalized", trackingStatus: null, tasks: [] })).toBe("DISCOVER");
    expect(derivePhase({ stage: "scored", trackingStatus: null, tasks: [] })).toBe("QUALIFY");
    expect(derivePhase({ stage: "qualified", trackingStatus: "saved", tasks: [] })).toBe("QUALIFY");
    expect(derivePhase({ stage: "applying", trackingStatus: "queued", tasks: [] })).toBe("APPLY");
    expect(derivePhase({ stage: "needs_human", trackingStatus: "saved", tasks: [] })).toBe("APPLY");
    expect(derivePhase({ stage: "applied", trackingStatus: "applied", tasks: [] })).toBe("SUBMITTED");
    expect(derivePhase({ stage: "applied", trackingStatus: "ready_to_contact", tasks: [] })).toBe("SUBMITTED");
  });

  it("puts replies, interviews and offers under FOLLOW_UP", () => {
    expect(derivePhase({ stage: "interviewing", trackingStatus: null, tasks: [] })).toBe("FOLLOW_UP");
    expect(derivePhase({ stage: "applied", trackingStatus: "interviewing", tasks: [] })).toBe("FOLLOW_UP");
    expect(derivePhase({ stage: "offer", trackingStatus: "offer", tasks: [] })).toBe("FOLLOW_UP");
    expect(derivePhase({ stage: "applied", trackingStatus: "applied", tasks: [{ kind: "outreach", status: "queued" }] })).toBe("FOLLOW_UP");
  });

  it("closes archived, duplicate and rejected jobs, unless the user is tracking an archived one", () => {
    expect(derivePhase({ stage: "archived", trackingStatus: null, tasks: [] })).toBe("CLOSED");
    expect(derivePhase({ stage: "duplicate", trackingStatus: null, tasks: [] })).toBe("CLOSED");
    expect(derivePhase({ stage: "applied", trackingStatus: "rejected", tasks: [] })).toBe("CLOSED");
    expect(derivePhase({ stage: "archived", trackingStatus: "saved", tasks: [] })).toBe("QUALIFY");
  });

  it("lets active tasks override the stage, and ignores finished ones", () => {
    expect(derivePhase({ stage: "qualified", trackingStatus: null, tasks: [{ kind: "apply", status: "leased" }] })).toBe("APPLY");
    expect(derivePhase({ stage: "qualified", trackingStatus: null, tasks: [{ kind: "tailor", status: "queued" }] })).toBe("TAILOR");
    expect(derivePhase({ stage: "qualified", trackingStatus: null, tasks: [{ kind: "apply", status: "done" }] })).toBe("QUALIFY");
    expect(derivePhase({ stage: "qualified", trackingStatus: null, tasks: [{ kind: "apply", status: "dead" }] })).toBe("QUALIFY");
  });
});

describe("nextAction", () => {
  const base = { stage: "qualified" as const, trackingStatus: null, hasOpenException: false, activeTaskKind: null, confirmed: false };
  it("asks for the right thing at each point", () => {
    expect(nextAction({ ...base, phase: "QUALIFY" })).toMatch(/Review it/);
    expect(nextAction({ ...base, phase: "QUALIFY", trackingStatus: "saved" })).toMatch(/Queue it/);
    expect(nextAction({ ...base, phase: "APPLY", stage: "applying", trackingStatus: "queued" })).toMatch(/apply worker/);
    expect(nextAction({ ...base, phase: "APPLY", stage: "needs_human" })).toMatch(/yourself/);
    expect(nextAction({ ...base, phase: "SUBMITTED", stage: "applied", trackingStatus: "applied", confirmed: false })).toMatch(/confirmation/);
    expect(nextAction({ ...base, phase: "SUBMITTED", stage: "applied", trackingStatus: "applied", confirmed: true })).toMatch(/Reach out/);
    expect(nextAction({ ...base, phase: "FOLLOW_UP", stage: "interviewing" })).toMatch(/interview/);
    expect(nextAction({ ...base, phase: "FOLLOW_UP", stage: "offer", trackingStatus: "offer" })).toMatch(/offer/);
    expect(nextAction({ ...base, phase: "FOLLOW_UP", stage: "applied", trackingStatus: "applied" })).toMatch(/Follow up/);
    expect(nextAction({ ...base, phase: "CLOSED" })).toMatch(/closed/);
  });
  it("prefers the inbox over everything else, then an active task", () => {
    expect(nextAction({ ...base, phase: "APPLY", hasOpenException: true, activeTaskKind: "apply" })).toMatch(/inbox/);
    expect(nextAction({ ...base, phase: "APPLY", activeTaskKind: "apply" })).toMatch(/apply is in progress/);
  });
});

describe("phaseCounts", () => {
  it("counts every phase including zeros", () => {
    const c = phaseCounts(["DISCOVER", "QUALIFY", "QUALIFY", "SUBMITTED", "FOLLOW_UP", "CLOSED"]);
    expect(c).toEqual({ DISCOVER: 1, QUALIFY: 2, TAILOR: 0, APPLY: 0, SUBMITTED: 1, FOLLOW_UP: 1, CLOSED: 1 });
  });
});

describe("workerStatus", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  it("is online only within two minutes of the last heartbeat", () => {
    expect(workerStatus("2026-11-07T11:59:30Z", now)).toBe("online");
    expect(workerStatus("2026-11-07T11:58:00Z", now)).toBe("online"); // exactly 2 minutes
    expect(workerStatus("2026-11-07T11:57:59Z", now)).toBe("offline");
  });
  it("treats missing or invalid timestamps as offline", () => {
    expect(workerStatus(null, now)).toBe("offline");
    expect(workerStatus("not a date", now)).toBe("offline");
  });
});

describe("queueDepth", () => {
  it("counts by status and ignores unknown statuses", () => {
    expect(queueDepth([{ status: "queued" }, { status: "queued" }, { status: "leased" }, { status: "dead" }, { status: "weird" }]))
      .toEqual({ queued: 2, leased: 1, done: 0, failed: 0, dead: 1 });
    expect(queueDepth([])).toEqual({ queued: 0, leased: 0, done: 0, failed: 0, dead: 0 });
  });
});

describe("successRate and summarizeApplyStats", () => {
  it("never reports a fake percentage when nothing was attempted", () => {
    expect(successRate(0, 0)).toBeNull();
    expect(successRate(1, 3)).toBe(33);
    expect(summarizeApplyStats([]).successRate).toBeNull();
  });

  it("counts confirmed, unverified and failed as attempts; dry runs and pending are not", () => {
    const s = summarizeApplyStats([
      { status: "succeeded", confirmed: true, provider: "greenhouse", strategy: "deterministic" },
      { status: "succeeded", confirmed: true, provider: "lever", strategy: "deterministic" },
      { status: "unverified", confirmed: false, provider: "greenhouse", strategy: "deterministic" },
      { status: "failed", confirmed: false, provider: "greenhouse", strategy: "stagehand" },
      { status: "dry_run", confirmed: false, provider: "greenhouse", strategy: "deterministic" },
      { status: "pending", confirmed: false, provider: null, strategy: null },
    ]);
    expect(s).toMatchObject({ attempted: 4, confirmed: 2, unverified: 1, failed: 1, successRate: 50 });
    expect(s.byProvider.greenhouse).toEqual({ attempted: 3, confirmed: 1, rate: 33 });
    expect(s.byProvider.lever).toEqual({ attempted: 1, confirmed: 1, rate: 100 });
    expect(s.byStrategy.deterministic).toEqual({ attempted: 3, confirmed: 2, rate: 67 });
    expect(s.byStrategy.stagehand).toEqual({ attempted: 1, confirmed: 0, rate: 0 });
  });

  it("does not count a 'succeeded' row without confirmation as confirmed", () => {
    const s = summarizeApplyStats([{ status: "succeeded", confirmed: false, provider: "ashby", strategy: null }]);
    expect(s).toMatchObject({ attempted: 1, confirmed: 0, unverified: 1, successRate: 0 });
    expect(s.byStrategy.unknown).toBeDefined();
  });
});

describe("source labels", () => {
  it("labels known sources and falls back readably", () => {
    expect(sourceLabel("handshake")).toBe("Handshake alerts");
    expect(sourceLabel("some_new_source")).toBe("some new source");
    expect(sourceTone("ok")).toBe("good");
    expect(sourceTone("failed")).toBe("bad");
    expect(sourceTone("not_configured")).toBe("neutral");
  });
});

describe("summarizeRun (Today page)", () => {
  it("reports an honest empty state when nothing has run", () => {
    const r = summarizeRun({ sources: [], discoverTasks: [], applyTasks: [], apps: [], openExceptions: 0 });
    expect(r).toMatchObject({ hasRun: false, lastDiscoveryAt: null, jobsFoundLastRun: 0, applyQueued: 0, applyRunning: 0, confirmed: 0, failed: 0 });
  });

  it("takes the newest discovery time from sources and finished discover tasks, and sums last-run items", () => {
    const r = summarizeRun({
      sources: [{ lastAttemptAt: "2026-11-07T08:00:00Z", itemsLastRun: 5 }, { lastAttemptAt: "2026-11-06T08:00:00Z", itemsLastRun: 2 }],
      discoverTasks: [{ status: "done", updatedAt: "2026-11-07T09:00:00Z" }, { status: "queued", updatedAt: "2026-11-07T10:00:00Z" }],
      applyTasks: [{ status: "queued" }, { status: "queued" }, { status: "leased" }, { status: "done" }],
      apps: [{ status: "succeeded", confirmed: true }, { status: "failed", confirmed: false }, { status: "unverified", confirmed: false }, { status: "dry_run", confirmed: false }],
      openExceptions: 3,
    });
    expect(r.lastDiscoveryAt).toBe("2026-11-07T09:00:00Z"); // an unfinished (queued) task does not count as a run
    expect(r).toMatchObject({ jobsFoundLastRun: 7, applyQueued: 2, applyRunning: 1, confirmed: 1, unverified: 1, failed: 1, openExceptions: 3, hasRun: true });
  });
});

describe("summarizeUsage", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const row = (metric: string, quantity: number, costUsd: number, createdAt: string, ref: string | null = null) => ({ metric, quantity, costUsd, ref, createdAt });

  it("keeps measured and estimated apart and never mixes them", () => {
    const s = summarizeUsage([
      row("llm.calls", 1, 0, "2026-11-07T10:00:00Z"),
      row("llm.input_tokens", 1000, 0, "2026-11-07T10:00:00Z"),
      row("llm.output_tokens", 200, 0.004, "2026-11-07T10:00:00Z"),
      row("llm.calls", 1, 0, "2026-11-07T11:00:00Z", "estimate"),
      row("llm.input_tokens", 500, 0, "2026-11-07T11:00:00Z", "estimate"),
      row("llm.output_tokens", 100, 0.002, "2026-11-07T11:00:00Z", "estimate"),
    ], now);
    expect(s.measured).toEqual({ calls: 1, inputTokens: 1000, outputTokens: 200, costUsd: 0.004 });
    expect(s.estimated).toEqual({ calls: 1, inputTokens: 500, outputTokens: 100, costUsd: 0.002 });
    expect(s.today).toEqual({ measuredUsd: 0.004, estimatedUsd: 0.002 });
  });

  it("derives calls from output-token rows when no llm.calls rows exist", () => {
    const s = summarizeUsage([row("llm.output_tokens", 50, 0.001, "2026-11-07T10:00:00Z"), row("llm.output_tokens", 70, 0.001, "2026-11-07T10:05:00Z")], now);
    expect(s.measured.calls).toBe(2);
    expect(s.measured.outputTokens).toBe(120);
  });

  it("separates today from this month and ignores spend from earlier months", () => {
    const s = summarizeUsage([
      row("llm.output_tokens", 1, 1, "2026-11-07T01:00:00Z"),
      row("llm.output_tokens", 1, 2, "2026-11-02T01:00:00Z"),
      row("llm.output_tokens", 1, 4, "2026-10-31T23:59:59Z"),
    ], now);
    expect(s.today.measuredUsd).toBe(1);
    expect(s.month.measuredUsd).toBe(3);
    expect(s.measured.costUsd).toBe(7); // all-time total still includes October
  });

  it("is all zeros for no rows", () => {
    expect(summarizeUsage([], now)).toEqual({
      measured: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, estimated: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      today: { measuredUsd: 0, estimatedUsd: 0 }, month: { measuredUsd: 0, estimatedUsd: 0 },
    });
  });
});

describe("limits", () => {
  const base = { dailyAiUsd: 2, monthlyAiUsd: 30, perApplicationAiUsd: 0.15, maxFallbackAttempts: 2, maxBrowserSeconds: 300 };
  it("overlays only positive finite numbers from stored preferences", () => {
    expect(mergeLimits({ dailyAiUsd: 5, monthlyAiUsd: -1, perApplicationAiUsd: "x", maxFallbackAttempts: 0 }, base))
      .toEqual({ ...base, dailyAiUsd: 5 });
    expect(mergeLimits(null, base)).toEqual(base);
    expect(mergeLimits("nope", base)).toEqual(base);
  });
  it("classifies spend against a limit", () => {
    expect(spendStatus(0.5, 2)).toEqual({ pct: 25, level: "ok" });
    expect(spendStatus(1.6, 2)).toEqual({ pct: 80, level: "warn" });
    expect(spendStatus(2, 2)).toEqual({ pct: 100, level: "over" });
    expect(spendStatus(5, 2)).toEqual({ pct: 100, level: "over" });
    expect(spendStatus(1, 0)).toEqual({ pct: null, level: "ok" });
  });
});

describe("n8n usage estimate", () => {
  it("is computed from the schedules, per day and per 30 days", () => {
    const e = estimateN8nExecutions();
    expect(e.workflows).toHaveLength(3);
    expect(e.perDay).toBe(10);
    expect(e.perMonth).toBe(300);
    expect(estimateN8nExecutions([{ name: "x", runsPerDay: 2 }]).perMonth).toBe(60);
  });
});

describe("summarizeBrowserRuns", () => {
  it("counts only finished apply tasks", () => {
    expect(summarizeBrowserRuns([{ status: "done" }, { status: "done" }, { status: "failed" }, { status: "dead" }, { status: "queued" }, { status: "leased" }]))
      .toEqual({ runs: 4, succeeded: 2, failed: 2 });
    expect(summarizeBrowserRuns([])).toEqual({ runs: 0, succeeded: 0, failed: 0 });
  });
});

describe("exception actions", () => {
  const apps = new Map([["app-1", "job-1"]]);
  it("finds the job for job exceptions and application exceptions only", () => {
    expect(exceptionJobId({ entityType: "job", entityId: "job-9" }, apps)).toBe("job-9");
    expect(exceptionJobId({ entityType: "application", entityId: "app-1" }, apps)).toBe("job-1");
    expect(exceptionJobId({ entityType: "application", entityId: "app-unknown" }, apps)).toBeNull();
    expect(exceptionJobId({ entityType: "integration", entityId: "gmail" }, apps)).toBeNull();
    expect(exceptionJobId({ entityType: "job", entityId: null }, apps)).toBeNull();
  });

  it("never retries a confirmed or unverified application", () => {
    expect(retryEligibility(null)).toEqual({ ok: true });
    expect(retryEligibility({ status: "failed", confirmed: false })).toEqual({ ok: true });
    expect(retryEligibility({ status: "dry_run", confirmed: false })).toEqual({ ok: true });
    expect(retryEligibility({ status: "succeeded", confirmed: true })).toEqual({ ok: false, reason: "already_confirmed" });
    expect(retryEligibility({ status: "unverified", confirmed: false })).toEqual({ ok: false, reason: "unverified_submission" });
  });

  it("builds a fresh idempotency key one past the highest retry", () => {
    expect(nextRetryKey("j1", [])).toBe("apply:j1:retry:1");
    expect(nextRetryKey("j1", ["apply:j1", "apply:j1:retry:1", "apply:j1:retry:3", "apply:j2:retry:9", "apply:j1:retry:x"])).toBe("apply:j1:retry:4");
  });
});
