# ROS HTTP API — contract used by the MCP server and n8n

Auth: `Authorization: Bearer <per-user ROS token>` for user routes (resolves to tenant/user). Internal routes use `x-ros-internal-secret: $N8N_WEBHOOK_SECRET` and are for n8n/cron only.

## User routes (consumed by packages/mcp-server)
| Method | Path | Notes |
|---|---|---|
| POST | /api/ingest | body = `IngestRequest`; returns `{ingestionId,status:"accepted"}` immediately |
| GET | /api/jobs?q=&stage=&minScore=&limit= | |
| GET | /api/pipeline | counts per stage + open exceptions |
| GET | /api/companies?name= | company + research + contacts |
| GET | /api/applications?jobId= | |
| PATCH | /api/preferences | partial `Preferences` |
| POST | /api/companies/research | `{company, jobId?}` |
| POST | /api/proof-of-work | `{company, jobId?}` |
| GET | /api/outreach?jobId=&contactId= | |
| POST | /api/chief-of-staff | `{question}` |

## Internal routes (consumed by n8n workflows; to be implemented by calling packages/workers)
| Method | Path | Implementation |
|---|---|---|
| POST | /api/internal/pipeline/run | `{ingestionId}` → `runPipeline`; `{drain:true}` → `processPending` |
| POST | /api/internal/ats-poll | public ATS feed connectors (Agent B) → `enqueueIngestion` |
| POST | /api/internal/outreach/tick | `runOutreachTick` (Agent C) |
| POST | /api/internal/daily-summary | `buildDailySummary` + `notify` |
| POST | /api/internal/gmail-poll | `createGmailConnectorFromEnv` → `alertToIngestRequests` + reply handling |
| GET | /api/internal/dlq?sinceMinutes= | `{count, items}` of dead-lettered ingestions |
| POST | /api/internal/notify | `{kind,title,body}` → `notify` |

STATUS: as of this commit these routes are NOT confirmed implemented in apps/web (Agent A owns routes). The pipeline/worker/notify/gmail functions behind them exist and are tested; the HTTP shells are the remaining wiring. See BLOCKERS/PROJECT_STATE.
