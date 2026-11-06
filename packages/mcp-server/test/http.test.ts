import { describe, it, expect } from "vitest";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpServer } from "../src/http.js";

describe("remote MCP (streamable HTTP)", () => {
  it("rejects missing token; forwards per-caller bearer to the API", async () => {
    const seen: string[] = [];
    const api = http.createServer((req, res) => { seen.push(String(req.headers.authorization)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ counts: {} })); });
    await new Promise<void>((r) => api.listen(0, r));
    const mcp = createMcpHttpServer({ apiBaseUrl: `http://127.0.0.1:${(api.address() as any).port}` });
    await new Promise<void>((r) => mcp.listen(0, r));
    const url = new URL(`http://127.0.0.1:${(mcp.address() as any).port}/mcp`);
    try {
      expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
      const c = new Client({ name: "t", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer user-a-token" } } }));
      expect((await c.listTools()).tools).toHaveLength(10);
      const r: any = await c.callTool({ name: "get_pipeline", arguments: {} });
      expect(r.isError).toBeFalsy(); expect(seen).toEqual(["Bearer user-a-token"]);
      await c.close();
    } finally { mcp.close(); api.close(); }
  });
});
