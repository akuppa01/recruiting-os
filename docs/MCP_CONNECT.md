# Connect Claude to Recruiting OS

You need `ROS_API_BASE_URL` (your deployed API) and a per-user `ROS_API_TOKEN` (Settings → Integrations once available). Enter the token in the client's config/connector secret field — not in chat.

## Claude Code (stdio)
```bash
claude mcp add recruiting-os \
  -e ROS_API_BASE_URL=https://YOUR-APP.vercel.app \
  -e ROS_API_TOKEN=YOUR_TOKEN \
  -- npx tsx /ABS/PATH/recruiting-os/packages/mcp-server/src/index.ts
```
(Run from a shell where you type the token yourself; don't paste it into a chat.)

## Claude Desktop (stdio) — `claude_desktop_config.json`
```json
{ "mcpServers": { "recruiting-os": {
  "command": "npx",
  "args": ["tsx", "/ABS/PATH/recruiting-os/packages/mcp-server/src/index.ts"],
  "env": { "ROS_API_BASE_URL": "https://YOUR-APP.vercel.app", "ROS_API_TOKEN": "YOUR_TOKEN" } } } }
```

## claude.ai Project (remote connector)
Host the HTTP transport: `ROS_MCP_HTTP_PORT=8787 ROS_API_BASE_URL=https://YOUR-APP.vercel.app npx tsx packages/mcp-server/src/index.ts` behind HTTPS (any Node host). Endpoint: `POST /mcp`; each caller's `Authorization: Bearer <token>` is forwarded to the API. Add it in claude.ai → Settings → Connectors → custom connector, then enable it in your Project and paste `claude-project/PROJECT_INSTRUCTIONS.md` into the Project instructions. Verify current connector UI/auth options in Anthropic's docs; this transport is tested only against the SDK client, not against claude.ai itself, and does not implement OAuth (bearer token only).
