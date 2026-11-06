import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RosApiError, RosClient } from "./client.js";
import { tools } from "./tools.js";

export function buildServer(client: RosClient): McpServer {
  const server = new McpServer({ name: "recruiting-os", version: "0.1.0" });
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.shape, annotations: { readOnlyHint: t.readOnly } },
      async (args: any) => {
        try {
          const out = await t.run(client, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(out ?? null, null, 2) }] };
        } catch (e) {
          const msg = e instanceof RosApiError ? `${e.message}${e.body ? `\n${JSON.stringify(e.body)}` : ""}` : e instanceof z.ZodError ? `Invalid input: ${e.message}` : (e as Error).message;
          return { isError: true, content: [{ type: "text" as const, text: `ERROR (no data was fabricated): ${msg}` }] };
        }
      },
    );
  }
  return server;
}
