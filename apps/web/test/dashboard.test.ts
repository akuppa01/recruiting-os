import { describe, expect, it } from "vitest";
import {
  derivePhase, nextAction, phaseCounts, queueDepth, successRate, summarizeApplyStats, workerStatus, sourceLabel, sourceTone,
} from "../src/lib/pipeline-view";

describe("derivePhase", () => {
  it("maps job stage and tracking to lifecycle phases", () => {
    expect(derivePhase({ stage: "normalized", trackingStatus: null, tasks: [] })).toBe("DISCOVER");
    expect(derivePhase({ stage: "scored", trackingStatus: null, tasks: [] })).toBe("QUALIFY");
    expect(derivePhase({ stage: "qualified", trackingStatus: "saved", tasks: [] })).toBe("QUALIFY");
    expect(derivePhase({ stage: "applying", trackingStatus: "queued", tasks: [] })).toBe("APPLY");
    expect(derivePhase({ stage: "needs_human", trackingStatus: "saved", tasks: [] })).toBe("APPLY");
    expect(derivePhase({ stage: "applied", trackingStatus: "applied", tasks: [] })).toBe("CONNECT");
    expect(derivePhase({ stage: "applied", trackingStatus: "ready_to_contact", tasks: [] })).toBe("CONNECT");
    expect(derivePhase({ stage: "interviewing", trackingStatus: null, tasks: [] })).toBe("INTERVIEW");
    expect(derivePhase({ stage: "offer", trackingStatus: "offer", tasks: [] })).toBe("OFFER");
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
    expect(nextAction({ ...base, phase: "CONNECT", stage: "applied", trackingStatus: "applied", confirmed: false })).toMatch(/confirmation/);
    expect(nextAction({ ...base, phase: "CONNECT", stage: "applied", trackingStatus: "applied", confirmed: true })).toMatch(/Reach out/);
    expect(nextAction({ ...base, phase: "CLOSED" })).toMatch(/closed/);
  });
  it("prefers the inbox over everything else, then an active task", () => {
    expect(nextAction({ ...base, phase: "APPLY", hasOpenException: true, activeTaskKind: "apply" })).toMatch(/inbox/);
    expect(nextAction({ ...base, phase: "APPLY", activeTaskKind: "apply" })).toMatch(/apply is in progress/);
  });
});

describe("phaseCounts", () => {
  it("counts every phase including zeros", () => {
    const c = phaseCounts(["DISCOVER", "QUALIFY", "QUALIFY", "CLOSED"]);
    expect(c).toMatchObject({ DISCOVER: 1, QUALIFY: 2, TAILOR: 0, APPLY: 0, CONNECT: 0, INTERVIEW: 0, OFFER: 0, CLOSED: 1 });
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
