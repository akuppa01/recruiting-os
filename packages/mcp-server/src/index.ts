#!/usr/bin/env tsx
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RosClient } from "./client.js";
import { buildServer } from "./server.js";

export { buildServer, RosClient };
if (process.argv[1] && /mcp-server[\\/]src[\\/]index\.ts$/.test(process.argv[1])) {
  const client = new RosClient({ baseUrl: process.env.ROS_API_BASE_URL ?? "", token: process.env.ROS_API_TOKEN ?? "" });
  await buildServer(client).connect(new StdioServerTransport());
}
