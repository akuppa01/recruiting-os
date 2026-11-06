# Architecture

```mermaid
flowchart LR
  subgraph Sources
    G[Gmail alerts] --> ING
    WA[WhatsApp export] --> ING
    SH[Sheets/CSV] --> ING
    ATS[Public ATS feeds] --> ING
    CL[Claude Project via MCP] -->|add_job| API
    UI[Web / mobile UI] --> API
  end
  API[/POST /api/ingest/] --> ING[(ingestions)]
  ING --> N8N{{n8n webhook + poller}}
  N8N --> PIPE[runPipeline]
  PIPE --> N[normalize+dedupe] --> R[research] --> S[score] --> Q{qualify?}
  Q -- no --> ARC[archive]
  Q -- yes --> RES[resume + cover letter] --> APP{policy gate}
  APP -- dry_run/autoApply off --> LOG[(events + external_actions)]
  APP -- live + verified --> AD[ATS adapter] --> V{confirmation evidence?}
  V -- yes --> DONE[applied]
  V -- no --> EXC[(exceptions queue)]
  Q -- high score --> POW[contacts + proof-of-work] --> OUT[outreach + follow-ups]
  PIPE -. failure x3 .-> DLQ[(dead letter + alert)]
  PIPE --> NOTI[ntfy / Pushover]
  DB[(Supabase Postgres + RLS)] --- PIPE
  DB --- API
```

Seams: `Store` interface (packages/core) isolates all persistence; stage functions are dependency-injected into the orchestrator (`PipelineStages`); the LLM and all external senders have dry-run/stub defaults.

Failure model: each stage retries 3× with exponential backoff (500ms base); then the ingestion is `dead_letter`, an exception is raised, a notification is sent. Dead-lettered items are not reprocessed automatically (see RUNBOOK).
