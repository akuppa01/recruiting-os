import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
const dir = new URL("../n8n/workflows/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("n8n workflow JSON (structural validation only; NOT executed in a live n8n)", () => {
  it("has the six required workflows", () => {
    for (const n of ["ingest-webhook", "ats-poll", "outreach-tick", "daily-summary", "dlq-alert", "gmail-poll"]) expect(files).toContain(`${n}.json`);
  });
  for (const f of files) it(`${f}: valid graph`, () => {
    const w = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    const names = w.nodes.map((n: any) => n.name);
    expect(new Set(names).size).toBe(names.length);
    const triggers = w.nodes.filter((n: any) => /Trigger$|webhook$/.test(n.type));
    expect(triggers).toHaveLength(1);
    for (const [from, c] of Object.entries<any>(w.connections)) {
      expect(names).toContain(from);
      for (const branch of c.main) for (const t of branch) expect(names).toContain(t.node);
    }
    // every non-trigger node is reachable from the trigger
    const seen = new Set<string>([triggers[0].name]); const q = [triggers[0].name];
    while (q.length) for (const b of w.connections[q.shift()!]?.main ?? []) for (const t of b) if (!seen.has(t.node)) { seen.add(t.node); q.push(t.node); }
    expect([...seen].sort()).toEqual([...names].sort());
    for (const n of w.nodes) {
      expect(n.id && n.type && n.typeVersion && Array.isArray(n.position)).toBeTruthy();
      if (n.type === "n8n-nodes-base.httpRequest") {
        expect(n.parameters.url).toContain("$env.ROS_API_BASE_URL");
        expect(JSON.stringify(n.parameters.headerParameters)).toContain("x-ros-internal-secret");
        expect(n.retryOnFail).toBe(true);
      }
    }
    expect(JSON.stringify(w)).not.toMatch(/(sk-ant|Bearer [A-Za-z0-9]{20,})/); // no embedded secrets
  });
});
