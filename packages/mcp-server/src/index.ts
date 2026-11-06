#!/usr/bin/env tsx
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RosClient } from "./client.js";
import { buildServer } from "./server.js";

export { buildServer, RosClient };
export { createMcpHttpServer } from "./http.js";
if (process.argv[1] && /mcp-server[\\/]src[\\/]index\.ts$/.test(process.argv[1])) {
  if (process.env.ROS_MCP_HTTP_PORT) {
    const { createMcpHttpServer } = await import("./http.js");
    createMcpHttpServer({ apiBaseUrl: process.env.ROS_API_BASE_URL ?? "" }).listen(Number(process.env.ROS_MCP_HTTP_PORT));
    console.error(`ros-mcp: streamable HTTP on :${process.env.ROS_MCP_HTTP_PORT}/mcp`);
  } else {
  const client = new RosClient({ baseUrl: process.env.ROS_API_BASE_URL ?? "", token: process.env.ROS_API_TOKEN ?? "" });
  await buildServer(client).connect(new StdioServerTransport());
  }
}
