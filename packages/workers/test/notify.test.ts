import { describe, it, expect } from "vitest";
import { InMemoryStore } from "../../db/src/memory.js";
import { DryRunNotifier, NtfyNotifier, PushoverNotifier, buildDailySummary, createNotifierFromEnv, inQuietHours, notify, priorityFor } from "../src/notify/index.js";
import { ctx } from "./helpers.js";

const okFetch = (log: any[]) => (async (u: any, i: any) => { log.push({ u: String(u), i }); return new Response("ok", { status: 200 }); }) as typeof fetch;
describe("notify", () => {
  it("priority rules", () => { expect(priorityFor("interview")).toBe("urgent"); expect(priorityFor("reply")).toBe("high"); expect(priorityFor("daily_summary")).toBe("low"); expect(priorityFor("exception")).toBe("default"); });
  it("ntfy request shape", async () => {
    const log: any[] = []; const n = new NtfyNotifier({ topic: "my topic", fetchImpl: okFetch(log) });
    const r = await n.send({ kind: "interview", title: "T", body: "B", priority: "urgent", url: "https://x" });
    expect(r.status).toBe("succeeded"); expect(log[0].u).toBe("https://ntfy.sh/my%20topic"); expect(log[0].i.headers.Priority).toBe("5"); expect(log[0].i.headers.Click).toBe("https://x");
  });
  it("pushover request shape + failure reported", async () => {
    const log: any[] = []; const p = new PushoverNotifier({ appToken: "a", userKey: "u", fetchImpl: okFetch(log) });
    expect((await p.send({ kind: "reply", title: "T", body: "B", priority: "high" })).status).toBe("succeeded");
    expect(String(log[0].i.body)).toContain("priority=1");
    const bad = new PushoverNotifier({ appToken: "a", userKey: "u", fetchImpl: (async () => new Response("", { status: 500 })) as any });
    expect((await bad.send({ kind: "reply", title: "T", body: "B", priority: "high" })).status).toBe("failed");
    const thr = new NtfyNotifier({ topic: "t", fetchImpl: (async () => { throw new Error("net"); }) as any });
    expect((await thr.send({ kind: "reply", title: "T", body: "B", priority: "high" })).detail).toBe("net");
  });
  it("env factory defaults to dry-run", () => { expect(createNotifierFromEnv({}).name).toBe("dry_run"); expect(createNotifierFromEnv({ NTFY_TOPIC: "x" }).name).toBe("ntfy"); });
  it("quiet hours suppress low only, and record external action", async () => {
    const s = new InMemoryStore(); const d = new DryRunNotifier(); const q = { startHour: 21, endHour: 7, tz: "UTC" }; const night = new Date("2026-11-06T23:00:00Z");
    expect(inQuietHours(night, q)).toBe(true); expect(inQuietHours(new Date("2026-11-06T12:00:00Z"), q)).toBe(false);
    expect((await notify(s, ctx, d, { kind: "high_score_job", title: "t", body: "b" }, { quiet: q, now: night })).status).toBe("suppressed");
    expect((await notify(s, ctx, d, { kind: "interview", title: "t", body: "b" }, { quiet: q, now: night })).status).toBe("dry_run");
    expect(s.externalActions).toHaveLength(2);
  });
  it("daily summary builds from store", async () => { const s = new InMemoryStore(); expect((await buildDailySummary(s, ctx)).body).toContain("Open exceptions: 0"); });
});
