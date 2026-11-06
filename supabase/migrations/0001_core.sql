-- Recruiting OS core schema. Owner: Agent A.
-- Conventions: every data table has tenant_id + user_id; RLS enabled; access requires
-- user_id = auth.uid() AND membership in tenant_id. The service role bypasses RLS (workers).

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------------------------------------------------------------- tenancy
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create or replace function public.is_tenant_member(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tenant_members m where m.tenant_id = t and m.user_id = auth.uid())
$$;

-- Onboarding helper: creates a tenant and owner membership for the calling user.
create or replace function public.bootstrap_tenant(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.tenants(name, owner_id) values (p_name, auth.uid()) returning id into t;
  insert into public.tenant_members(tenant_id, user_id, role) values (t, auth.uid(), 'owner');
  insert into public.profiles(tenant_id, user_id) values (t, auth.uid());
  insert into public.automation_policies(tenant_id, user_id) values (t, auth.uid());
  return t;
end $$;

-- ---------------------------------------------------------------- per-user config
create table public.profiles (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text,
  preferences jsonb not null default '{}'::jsonb,       -- partial Preferences (core/domain.ts)
  application_profile jsonb not null default '{}'::jsonb, -- reusable form answers (never secrets)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table public.automation_policies (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  policy jsonb not null default '{"mode":"dry_run","autoApply":false,"autoOutreach":false}'::jsonb,
  verified_integrations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,                      -- sha256 hex of the bearer token; plaintext never stored
  label text not null default 'mcp',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  flag text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id, flag)
);

-- ---------------------------------------------------------------- pipeline
create table public.ingestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  request jsonb not null,
  source text not null,
  idempotency_key text,
  status text not null default 'accepted' check (status in ('accepted','processing','done','failed','dead_letter')),
  job_id uuid,
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ingestions_idem on public.ingestions(tenant_id, user_id, idempotency_key) where idempotency_key is not null;
create index ingestions_status on public.ingestions(status, created_at);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ingestion_id uuid not null references public.ingestions(id) on delete cascade,
  stage text not null default 'normalized',
  normalized jsonb not null,
  score jsonb,
  score_total numeric,
  dedupe_key text not null,
  duplicate_of uuid references public.jobs(id) on delete set null,
  company text generated always as (normalized->>'company') stored,
  title text generated always as (normalized->>'title') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id, ingestion_id)
);
create unique index jobs_dedupe on public.jobs(tenant_id, user_id, dedupe_key) where duplicate_of is null;
create index jobs_stage on public.jobs(tenant_id, user_id, stage);
create index jobs_score on public.jobs(tenant_id, user_id, score_total desc nulls last);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  domain text,
  research jsonb,
  researched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index companies_name on public.companies(tenant_id, user_id, lower(name));

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  title text,
  email text,
  linkedin_url text,
  relevance numeric not null default 0,
  source text not null default 'unknown',
  suppressed boolean not null default false,
  suppress_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index contacts_company on public.contacts(tenant_id, user_id, company_id);

create table public.resume_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  archetype text not null,
  evidence_ids text[] not null default '{}',
  relevance_score numeric not null default 0,
  factual_confidence numeric not null default 0,
  storage_path text,
  content_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.cover_letters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  body text not null,
  evidence_ids text[] not null default '{}',
  storage_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  idempotency_key text not null,
  status text not null default 'pending' check (status in ('pending','succeeded','failed','unverified','dry_run')),
  confirmed boolean not null default false,
  resume_version_id uuid references public.resume_versions(id) on delete set null,
  cover_letter_id uuid references public.cover_letters(id) on delete set null,
  evidence jsonb,
  submitted_at timestamptz,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, job_id),                           -- one application per job: duplicate-submission guard
  unique (tenant_id, idempotency_key),
  -- an application can only be confirmed with confirmation evidence
  constraint applications_confirmed_needs_evidence check (confirmed = false or evidence is not null)
);

create table public.evidence_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  slug text not null,
  employer text not null, role text not null, dates text not null,
  statement text not null,
  metrics text[] not null default '{}',
  tags text[] not null default '{}',
  verified_by text not null check (verified_by in ('resume','supporting_doc','user_confirmed')),
  source_doc text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id, slug)
);

create table public.outreach_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  step int not null default 1,
  channel text not null default 'email' check (channel = 'email'),
  status text not null default 'draft' check (status in ('draft','scheduled','sent','dry_run','failed','stopped')),
  subject text not null,
  body text not null,
  scheduled_for timestamptz,
  sent_at timestamptz,
  thread_id text,
  stop_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outreach_due on public.outreach_messages(tenant_id, user_id, status, scheduled_for);

-- ---------------------------------------------------------------- observability
create table public.events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  entity_type text not null,
  entity_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index events_entity on public.events(tenant_id, user_id, entity_id, created_at);

create table public.exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  entity_type text not null,
  entity_id text,
  detail text not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.dead_letters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ingestion_id uuid references public.ingestions(id) on delete set null,
  stage text,
  payload jsonb not null default '{}'::jsonb,
  error text not null,
  attempts int not null default 0,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.external_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  system text not null,
  action text not null,
  status text not null check (status in ('succeeded','failed','unverified','dry_run')),
  entity_id text,
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  metric text not null,                  -- e.g. 'llm.input_tokens', 'llm.output_tokens', 'applications', 'emails'
  quantity numeric not null default 0,
  cost_usd numeric not null default 0,
  model text,
  ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index usage_user_time on public.usage_events(tenant_id, user_id, created_at);

-- ---------------------------------------------------------------- triggers
do $$
declare t text;
begin
  foreach t in array array['tenants','profiles','automation_policies','api_tokens','feature_flags','ingestions','jobs','companies',
    'contacts','resume_versions','cover_letters','applications','evidence_items','outreach_messages','events','exceptions',
    'dead_letters','external_actions','usage_events'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', t||'_updated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- RLS
alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;

create policy tenants_select on public.tenants for select using (public.is_tenant_member(id));
create policy tenants_update on public.tenants for update using (owner_id = auth.uid() and public.is_tenant_member(id));
-- inserts go through bootstrap_tenant() (security definer); no direct insert/delete policy for clients.
create policy members_select on public.tenant_members for select using (user_id = auth.uid());
-- membership is managed only by the service role / bootstrap_tenant().

do $$
declare
  t text;
  full_access text[] := array['profiles','automation_policies','api_tokens','feature_flags','ingestions','jobs','companies',
    'contacts','resume_versions','cover_letters','applications','evidence_items','outreach_messages','exceptions','dead_letters'];
  append_only text[] := array['events','external_actions','usage_events'];
  pred text := 'user_id = auth.uid() and public.is_tenant_member(tenant_id)';
begin
  foreach t in array full_access loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select using (%s)', t||'_sel', t, pred);
    execute format('create policy %I on public.%I for insert with check (%s)', t||'_ins', t, pred);
    execute format('create policy %I on public.%I for update using (%s) with check (%s)', t||'_upd', t, pred, pred);
    execute format('create policy %I on public.%I for delete using (%s)', t||'_del', t, pred);
  end loop;
  foreach t in array append_only loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select using (%s)', t||'_sel', t, pred);
    execute format('create policy %I on public.%I for insert with check (%s)', t||'_ins', t, pred);
  end loop;
end $$;
