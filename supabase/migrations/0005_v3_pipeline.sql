-- V3 pipeline: durable task queue, execution logs, worker heartbeats, per-source health, shared ATS form templates.
-- Additive only. Workers use the service role (RLS bypass) and always filter by tenant_id + user_id.

-- ---------------------------------------------------------------- durable tasks
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('discover','ingest','qualify','tailor','apply','verify','outreach')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','leased','done','failed','dead')),
  idempotency_key text not null,
  priority int not null default 0,                      -- higher runs first (deadline-driven)
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),         -- backoff / scheduling
  lease_until timestamptz,                              -- expired lease => task is recoverable
  worker_id text,
  last_error text,
  result jsonb,
  cost_usd numeric not null default 0,                  -- AI + browser cost attributed to this task
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id, idempotency_key)
);
create index tasks_ready on public.tasks(status, run_after, priority desc, created_at);
create index tasks_owner on public.tasks(tenant_id, user_id, kind, status);

create table public.task_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  level text not null default 'info' check (level in ('debug','info','warn','error')),
  message text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index task_logs_task on public.task_logs(task_id, created_at);

create table public.worker_heartbeats (
  worker_id text primary key,
  host text,
  kinds text[] not null default '{}',
  current_task uuid references public.tasks(id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

-- ---------------------------------------------------------------- source health
create table public.source_health (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  status text not null default 'not_configured' check (status in ('ok','degraded','failed','not_configured')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  items_last_run int not null default 0,
  items_total int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id, source)
);

-- ---------------------------------------------------------------- shared ATS form templates (no personal data)
create table public.ats_form_templates (
  id uuid primary key default gen_random_uuid(),
  provider text not null,                               -- greenhouse | lever | ashby | workday | ...
  signature text not null,                              -- hash of the form's field structure
  version int not null default 1,
  field_map jsonb not null default '[]'::jsonb,         -- [{label, selector, kind, mapsTo}]
  upload_behavior jsonb not null default '{}'::jsonb,
  validation_rules jsonb not null default '{}'::jsonb,
  confirmation_signals jsonb not null default '{}'::jsonb,
  success_count int not null default 0,
  failure_count int not null default 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, signature)
);

-- ---------------------------------------------------------------- triggers + RLS
do $$
declare t text;
begin
  foreach t in array array['tasks','source_health','ats_form_templates'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', t||'_updated', t);
  end loop;
end $$;

alter table public.tasks enable row level security;
alter table public.task_logs enable row level security;
alter table public.worker_heartbeats enable row level security;
alter table public.source_health enable row level security;
alter table public.ats_form_templates enable row level security;

-- Users read their own rows; only workers (service role) write.
create policy tasks_sel on public.tasks for select using (user_id = auth.uid() and public.is_tenant_member(tenant_id));
create policy task_logs_sel on public.task_logs for select using (user_id = auth.uid() and public.is_tenant_member(tenant_id));
create policy source_health_sel on public.source_health for select using (user_id = auth.uid() and public.is_tenant_member(tenant_id));
-- Templates hold selectors and field labels only; any signed-in user may read them.
create policy ats_form_templates_sel on public.ats_form_templates for select using (auth.uid() is not null);
-- worker_heartbeats: no client policies (service role only).
