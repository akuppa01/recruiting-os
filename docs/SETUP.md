# Setup checklist (you do these; secrets never go in chat)

**Where secrets live:** local dev → `.env.local` (git-ignored). Production web/API → Vercel Project → Settings → Environment Variables. Supabase Edge/DB secrets → Supabase dashboard → Project Settings → Edge Functions → Secrets. n8n → n8n Credentials / environment. Never paste keys into Claude chat, GitHub, or logs.

Names of every variable are in `.env.example`.

## 1. Supabase (database, auth, storage) — blocker B-001
1. Create project: https://supabase.com/dashboard/new (pick a region near you; save the DB password in a password manager).
2. Project Settings → API (https://supabase.com/dashboard/project/_/settings/api): copy **Project URL**, **anon key**, **service_role key**.
3. Put them in `.env.local` / Vercel as `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. `service_role` is server-only — never expose with a `NEXT_PUBLIC_` prefix.
4. Apply migrations from `supabase/migrations/` (SQL editor, or `npx supabase link` + `npx supabase db push`).
5. Verify: run the live conformance suite (see RUNBOOK "Verify live Supabase").

## 2. Anthropic API key — B-002
1. https://console.anthropic.com/settings/keys → Create key. 2. Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`) in `.env.local` / Vercel. Without it, LLM stages run in deterministic stub mode (outputs tagged `source: "stub"`).

## 3. Vercel (web + API) — B-005
1. https://vercel.com/new → import the Git repo, root directory `apps/web`. 2. Add all env vars from `.env.example` (Production + Preview). 3. Deploy. Note the URL → `ROS_API_BASE_URL`.

## 4. Gmail OAuth — B-004
1. https://console.cloud.google.com/projectcreate → new project.
2. Enable Gmail API: https://console.cloud.google.com/apis/library/gmail.googleapis.com
3. OAuth consent screen: https://console.cloud.google.com/apis/credentials/consent — User type External, add yourself as a test user. **Gotcha:** while publishing status is "Testing", Google expires refresh tokens after 7 days; for lasting access move the app to "In production" (unverified-app warning is expected for a personal-use app) .
4. Credentials: https://console.cloud.google.com/apis/credentials → Create OAuth client ID → Web application → add redirect `https://developers.google.com/oauthplayground`.
5. Put `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env.local`/Vercel.
6. Get a refresh token: https://developers.google.com/oauthplayground → gear icon → "Use your own OAuth credentials" → authorize scopes `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.send` → exchange code → copy **refresh token** → store as `GMAIL_REFRESH_TOKEN` (env only).
7. Verify: `GET /api/internal/gmail-poll` returns connected (not "Gmail not connected: missing …"). Outreach stays `dry_run` until you promote it (RUNBOOK).

## 5. n8n — B-005
1. Cloud: https://n8n.io/ (or self-host: https://docs.n8n.io/hosting/). 2. Settings → Import workflows from `n8n/workflows/*.json`. 3. Set n8n environment `ROS_API_BASE_URL` and `N8N_WEBHOOK_SECRET`; workflows read them via `$env` — verify against current n8n docs that env access in nodes is enabled for your instance (`N8N_BLOCK_ENV_ACCESS_IN_NODE`). 4. Create a **Header Auth** credential: name `x-ros-secret`, value = `N8N_WEBHOOK_SECRET`; attach to the "Webhook" node of *Ingest webhook*. 5. Set `N8N_BASE_URL` in the web app env. 6. Activate workflows one at a time. These JSON files are structurally validated only; they have not been run in a live n8n.

## 6. Push notifications (pick one)
- **ntfy** (simplest): install the ntfy app (https://ntfy.sh), subscribe to a long random topic, set `NTFY_TOPIC`. Topics on ntfy.sh are public-by-obscurity; use a long random name or self-host/auth.
- **Pushover**: https://pushover.net/apps/build → create app → `PUSHOVER_APP_TOKEN`; your user key is on https://pushover.net → `PUSHOVER_USER_KEY`.
With neither set, notifications are recorded as `dry_run` only.

## 7. Contact discovery (optional)
- **Apollo**: https://app.apollo.io/#/settings/integrations/api → API key → `APOLLO_API_KEY`, `CONTACT_PROVIDER=apollo`.
- **Snov.io**: https://app.snov.io/api-setting → `SNOV_CLIENT_ID`/`SNOV_CLIENT_SECRET`, `CONTACT_PROVIDER=snov`.
Unconfigured providers are skipped and reported, never treated as "no contacts".

## 8. Resume evidence — B-003
Place your resume/supporting docs per `resumes/evidence/README.md` in `resumes/evidence/private/` (git-ignored). With an empty evidence bank, applications are blocked with an exception rather than using invented content.

## 9. Connect Claude
See `docs/MCP_CONNECT.md`.
