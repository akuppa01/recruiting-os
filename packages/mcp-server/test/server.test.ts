import { describe, it, expect, afterAll, beforeAll } from "vitest";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, RosClient } from "../src/index.js";

let srv: http.Server; let base = ""; const seen: any[] = [];
beforeAll(async () => {
  srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      seen.push({ m: req.method, u: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
      res.setHeader("content-type", "application/json");
      if (req.url!.startsWith("/api/ingest")) return res.end(JSON.stringify({ ingestionId: "11111111-1111-4111-8111-111111111111", status: "accepted" }));
      if (req.url!.startsWith("/api/applications")) { res.statusCode = 404; return res.end(JSON.stringify({ error: "not found" })); }
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, r)); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(() => srv.close());

async function connect(baseUrl: string, token = "tok") {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(new RosClient({ baseUrl, token })).connect(a);
  const c = new Client({ name: "t", version: "0" }); await c.connect(b); return c;
}
const text = (r: any) => r.content[0].text as string;

describe("mcp server", () => {
  it("exposes the 10 required tools", async () => {
    const c = await connect(base);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["add_job","ask_recruiting_chief_of_staff","generate_proof_of_work","get_application_status","get_company","get_outreach_status","get_pipeline","run_company_research","search_jobs","update_preferences"]);
  });
  it("add_job posts to /api/ingest with bearer token", async () => {
    const c = await connect(base);
    const r: any = await c.callTool({ name: "add_job", arguments: { url: "https://boards.greenhouse.io/acme/jobs/123" } });
    expect(JSON.parse(text(r)).ingestionId).toMatch(/^1111/);
    const last = seen.at(-1); expect(last.m).toBe("POST"); expect(last.auth).toBe("Bearer tok"); expect(last.body.url).toContain("greenhouse");
  });
  it("search_jobs passes query params", async () => {
    const c = await connect(base);
    await c.callTool({ name: "search_jobs", arguments: { text: "product", minScore: 70 } });
    expect(seen.at(-1).u).toContain("q=product"); expect(seen.at(-1).u).toContain("minScore=70");
  });
  it("surfaces API errors without fabricating", async () => {
    const c = await connect(base);
    const r: any = await c.callTool({ name: "get_application_status", arguments: { jobId: "11111111-1111-4111-8111-111111111111" } });
    expect(r.isError).toBe(true); expect(text(r)).toContain("404");
  });
  it("reports unreachable API clearly", async () => {
    const c = await connect("http://127.0.0.1:1");
    const r: any = await c.callTool({ name: "get_pipeline", arguments: {} });
    expect(r.isError).toBe(true); expect(text(r)).toContain("unreachable");
  });
  it("errors when token missing", async () => {
    const c = await connect(base, "");
    const r: any = await c.callTool({ name: "get_pipeline", arguments: {} });
    expect(r.isError).toBe(true); expect(text(r)).toContain("ROS_API_TOKEN");
  });
  it("add_job requires url or text", async () => {
    const c = await connect(base);
    const r: any = await c.callTool({ name: "add_job", arguments: {} });
    expect(r.isError).toBe(true);
  });
});
