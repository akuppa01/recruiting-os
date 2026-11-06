// Remote MCP over Streamable HTTP (stateless) for claude.ai custom connectors.
// Per-user auth: the caller's `Authorization: Bearer <ROS token>` is forwarded to the ROS API, which enforces tenancy/RLS.
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RosClient } from "./client.js";
import { buildServer } from "./server.js";

export function createMcpHttpServer(o: { apiBaseUrl: string; fetchImpl?: typeof fetch }): http.Server {
  return http.createServer(async (req, res) => {
    if (req.url === "/healthz") { res.writeHead(200).end("ok"); return; }
    if (req.url !== "/mcp" || req.method !== "POST") { res.writeHead(req.url === "/mcp" ? 405 : 404, { allow: "POST" }).end(); return; }
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!token) { res.writeHead(401, { "www-authenticate": "Bearer" }).end(JSON.stringify({ error: "missing bearer token" })); return; }
    const server = buildServer(new RosClient({ baseUrl: o.apiBaseUrl, token, fetchImpl: o.fetchImpl }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch (e) { if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: (e as Error).message })); }
  });
}
