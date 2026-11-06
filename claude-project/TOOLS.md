# Recruiting OS MCP tools

| Tool | Use | Writes? |
|---|---|---|
| `add_job` | Send a URL or pasted JD to `/api/ingest`; returns `ingestionId` immediately | yes (creates ingestion) |
| `search_jobs` | Filter jobs by text, stage, min score | no |
| `get_pipeline` | Counts by stage + open exceptions | no |
| `get_company` | Company record, labelled research, contacts | no |
| `get_application_status` | Status/confirmation evidence for a job | no |
| `update_preferences` | Patch preferences / automation policy (`policy.mode` live/dry_run) | yes |
| `run_company_research` | Queue research for a company | yes (queues) |
| `generate_proof_of_work` | Queue a proof-of-work dashboard + Loom script | yes (queues) |
| `get_outreach_status` | Outreach steps, statuses, suppression | no |
| `ask_recruiting_chief_of_staff` | Question answered from DB state | no |

All tools return the API's JSON verbatim; errors are returned with `isError` and no fabricated data.
