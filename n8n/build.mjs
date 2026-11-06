// Generates n8n/workflows/*.json. Run: node n8n/build.mjs  (JSON is committed; edit here, not the JSON)
import { writeFileSync } from "node:fs";
const BASE = "={{$env.ROS_API_BASE_URL}}";
const hdr = { parameters: [{ name: "x-ros-internal-secret", value: "={{$env.N8N_WEBHOOK_SECRET}}" }] };
const http = (name, method, path, pos, extra = {}) => ({
  id: name.toLowerCase().replace(/\W+/g, "-"), name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: { method, url: `${BASE}${path}`, sendHeaders: true, headerParameters: hdr, options: { timeout: 60000 }, ...extra },
});
const sched = (name, rule) => ({ id: name.toLowerCase().replace(/\W+/g, "-"), name, type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [rule] } } });
const link = (a, b, i = 0) => ({ [a]: { main: [[{ node: b, type: "main", index: i }]] } });
const wf = (name, nodes, connections) => ({ name, nodes, connections, active: false, settings: { executionOrder: "v1" }, tags: [{ name: "recruiting-os" }] });
const out = {};

out["ingest-webhook"] = wf("ROS · Ingest webhook → pipeline", [
  { id: "webhook", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], webhookId: "ros-ingest",
    parameters: { httpMethod: "POST", path: "ros-ingest", responseMode: "onReceived", responseCode: 202, authentication: "headerAuth" } },
  http("Run pipeline", "POST", "/api/internal/pipeline/run", [300, 0], { sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify({ ingestionId: $json.body.ingestionId }) }}" }),
], link("Webhook", "Run pipeline"));

out["pipeline-poller"] = wf("ROS · Pipeline poller (safety net)", [
  { ...sched("Every minute", { field: "minutes", minutesInterval: 1 }) },
  http("Process pending", "POST", "/api/internal/pipeline/run", [300, 0], { sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify({ drain: true }) }}" }),
], link("Every minute", "Process pending"));

out["ats-poll"] = wf("ROS · Public ATS feed poll", [
  sched("Every 30 min", { field: "minutes", minutesInterval: 30 }),
  http("Poll ATS feeds", "POST", "/api/internal/ats-poll", [300, 0]),
], link("Every 30 min", "Poll ATS feeds"));

out["outreach-tick"] = wf("ROS · Outreach tick (hourly)", [
  sched("Hourly", { field: "hours", hoursInterval: 1 }),
  http("Run outreach tick", "POST", "/api/internal/outreach/tick", [300, 0]),
], link("Hourly", "Run outreach tick"));

out["daily-summary"] = wf("ROS · Daily summary", [
  sched("Daily 08:00", { field: "cronExpression", expression: "0 8 * * *" }),
  http("Send daily summary", "POST", "/api/internal/daily-summary", [300, 0]),
], link("Daily 08:00", "Send daily summary"));

out["gmail-poll"] = wf("ROS · Gmail poll (alerts + replies)", [
  sched("Every 10 min", { field: "minutes", minutesInterval: 10 }),
  http("Poll Gmail", "POST", "/api/internal/gmail-poll", [300, 0]),
], link("Every 10 min", "Poll Gmail"));

out["dlq-alert"] = wf("ROS · Dead-letter alert", [
  sched("Every 15 min", { field: "minutes", minutesInterval: 15 }),
  http("Fetch dead letters", "GET", "/api/internal/dlq?sinceMinutes=15", [300, 0]),
  { id: "any", name: "Any dead letters?", type: "n8n-nodes-base.if", typeVersion: 2, position: [600, 0],
    parameters: { conditions: { options: { caseSensitive: true, typeValidation: "strict" }, combinator: "and", conditions: [{ id: "c1", leftValue: "={{ $json.count }}", rightValue: 0, operator: { type: "number", operation: "gt" } }] } } },
  http("Notify", "POST", "/api/internal/notify", [900, -100], { sendBody: true, specifyBody: "json", jsonBody: '={{ JSON.stringify({ kind: "dead_letter", title: "Recruiting OS: " + $json.count + " dead-lettered item(s)", body: "See Notifications & Exceptions." }) }}' }),
], { ...link("Every 15 min", "Fetch dead letters"), ...link("Fetch dead letters", "Any dead letters?"), ...link("Any dead letters?", "Notify", 0) });

for (const [k, v] of Object.entries(out)) writeFileSync(new URL(`./workflows/${k}.json`, import.meta.url), JSON.stringify(v, null, 2) + "\n");
console.log("wrote", Object.keys(out).length, "workflows");
