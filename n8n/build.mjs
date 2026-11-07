// Generates the THREE n8n workflows in n8n/workflows/*.json. JSON is committed; edit here, not the JSON.
//   node n8n/build.mjs                              daily discovery
//   node n8n/build.mjs --discovery=twice_weekly     discovery on Mondays and Thursdays (low-cost mode)
//   node n8n/build.mjs --discovery-hour=6           UTC hour for discovery (default 6)
// Design: n8n is only a clock. Each workflow makes one (or two) calls to a backend batch endpoint that ENQUEUES durable tasks and
// returns. There is never an n8n execution per job, field or browser action.
// Required n8n variables: ROS_API_BASE_URL (e.g. https://your-app.vercel.app) and CRON_SECRET (same value as the Vercel env var).
import { writeFileSync } from "node:fs";

const arg = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt;
const schedule = arg("discovery", "daily");
if (!["daily", "twice_weekly"].includes(schedule)) throw new Error(`--discovery must be daily or twice_weekly, got ${schedule}`);
const hour = Number(arg("discovery-hour", "6"));
if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("--discovery-hour must be 0-23");

const BASE = "={{$env.ROS_API_BASE_URL}}";
const hdr = { parameters: [{ name: "authorization", value: "=Bearer {{$env.CRON_SECRET}}" }] };
const id = (name) => name.toLowerCase().replace(/\W+/g, "-");

const http = (name, path, pos, body) => ({
  id: id(name), name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 10000,
  parameters: {
    method: "POST", url: `${BASE}${path}`, sendHeaders: true, headerParameters: hdr, options: { timeout: 30000 },
    ...(body ? { sendBody: true, specifyBody: "json", jsonBody: JSON.stringify(body) } : {}),
  },
});
const cron = (name, expression) => ({
  id: id(name), name, type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 0],
  parameters: { rule: { interval: [{ field: "cronExpression", expression }] } },
});
const chain = (...names) => Object.fromEntries(names.slice(0, -1).map((n, i) => [n, { main: [[{ node: names[i + 1], type: "main", index: 0 }]] }]));
const wf = (name, nodes, connections) => ({ name, nodes, connections, active: false, settings: { executionOrder: "v1" }, tags: [{ name: "recruiting-os" }] });

const out = {};

out["discovery-batch"] = wf(
  `ROS · A · Discovery batch (${schedule === "daily" ? "daily" : "Mon + Thu"})`,
  [cron("Discovery schedule", schedule === "daily" ? `0 ${hour} * * *` : `0 ${hour} * * 1,4`), http("Enqueue discovery", "/api/internal/discover", [300, 0], { schedule })],
  chain("Discovery schedule", "Enqueue discovery"),
);

out["processing-batch"] = wf(
  "ROS · B · Processing batch (daily)",
  [cron("Processing schedule", "0 7 * * *"), http("Enqueue processing", "/api/internal/process", [300, 0], {})],
  chain("Processing schedule", "Enqueue processing"),
);

// Workflow C reads the user's Tepper inbox through an n8n Gmail credential (select it on the Gmail node after import),
// aggregates EVERYTHING into one array, and makes ONE POST. One n8n execution per run, never per email.
const GMAIL_QUERY = "newer_than:2d (from:joinhandshake.com OR from:12twenty.com OR from:linkedin.com OR from:indeed.com OR from:indeedmail.com OR from:greenhouse.io OR from:lever.co OR from:ashbyhq.com OR (in:inbox subject:re))";
const AGGREGATE_JS = `// Collapse every Gmail item into ONE { emails: [...] } item (the endpoint caps at 200 emails / 1 MB).
const hdr = (m, name) => ((m.payload && m.payload.headers) || m.headers || []).find((h) => (h.name || '').toLowerCase() === name)?.value;
const decode = (b64) => { try { return Buffer.from(String(b64).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return ''; } };
const bodyOf = (p) => !p ? '' : (p.mimeType === 'text/plain' && p.body && p.body.data ? decode(p.body.data) : (p.parts || []).map(bodyOf).join('\\n'));
const emails = $input.all().map((i) => i.json).map((m) => ({
  from: m.From || (m.from && m.from.text) || hdr(m, 'from') || '',
  subject: m.Subject || m.subject || hdr(m, 'subject') || '',
  text: m.text || m.textPlain || bodyOf(m.payload) || m.snippet || '',
  date: m.date ? String(m.date) : (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : (hdr(m, 'date') || undefined)),
  messageId: m.id || m.messageId || '',
  threadId: m.threadId || undefined,
})).filter((e) => e.from && e.messageId).slice(0, 200);
return [{ json: { emails } }];`;

const gmailGetMany = {
  id: "gmail-get-many", name: "Gmail: get recent messages", type: "n8n-nodes-base.gmail", typeVersion: 2.1, position: [300, 0],
  alwaysOutputData: true,                      // still run the Code node (with zero emails) when nothing matches
  parameters: { resource: "message", operation: "getAll", returnAll: false, limit: 200, simple: false, filters: { q: GMAIL_QUERY, readStatus: "both" } },
};
const aggregate = {
  id: "aggregate-emails", name: "Aggregate emails", type: "n8n-nodes-base.code", typeVersion: 2, position: [600, 0],
  parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: AGGREGATE_JS },
};
const postEmails = {
  ...http("POST emails to backend", "/api/internal/gmail-sync", [900, 0]),
};
postEmails.parameters = { ...postEmails.parameters, sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify({ emails: $json.emails }) }}" };

out["gmail-followups"] = wf(
  "ROS · C · Gmail sync + due follow-ups (every 3h)",
  [cron("Gmail schedule", "0 */3 * * *"), gmailGetMany, aggregate, postEmails, http("Enqueue due follow-ups", "/api/internal/followups", [1200, 0], {})],
  chain("Gmail schedule", "Gmail: get recent messages", "Aggregate emails", "POST emails to backend", "Enqueue due follow-ups"),
);

for (const [k, v] of Object.entries(out)) writeFileSync(new URL(`./workflows/${k}.json`, import.meta.url), JSON.stringify(v, null, 2) + "\n");
console.log(`wrote ${Object.keys(out).length} workflows (discovery: ${schedule}, hour ${hour} UTC)`);
