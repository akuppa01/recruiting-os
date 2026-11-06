-- Performance: add missing FK indexes flagged by Supabase advisor.
-- Tables covered by existing composite indexes or PKs are excluded.
-- Agent A, cycle 2.

-- api_tokens: no existing non-PK index; RLS checks user_id + tenant_id on every request
create index api_tokens_tenant_user on public.api_tokens(tenant_id, user_id);

-- applications: unique constraints cover (tenant_id, job_id) and (tenant_id, idempotency_key),
-- but user_id, cover_letter_id, resume_version_id have no index
create index applications_user on public.applications(user_id);
create index applications_cover_letter on public.applications(cover_letter_id) where cover_letter_id is not null;
create index applications_resume_version on public.applications(resume_version_id) where resume_version_id is not null;

-- resume_versions and cover_letters: no composite index exists; job_id used in joins
create index resume_versions_tenant_user on public.resume_versions(tenant_id, user_id, job_id);
create index cover_letters_tenant_user on public.cover_letters(tenant_id, user_id, job_id);

-- exceptions, dead_letters, external_actions: no index at all; RLS hits every row on select
create index exceptions_tenant_user on public.exceptions(tenant_id, user_id);
create index dead_letters_tenant_user on public.dead_letters(tenant_id, user_id);
create index dead_letters_ingestion on public.dead_letters(ingestion_id) where ingestion_id is not null;
create index external_actions_tenant_user on public.external_actions(tenant_id, user_id);

-- outreach_messages: outreach_due covers (tenant_id, user_id, status, scheduled_for)
-- but contact_id and job_id are unindexed; used in join lookups
create index outreach_contact on public.outreach_messages(contact_id);
create index outreach_job on public.outreach_messages(job_id) where job_id is not null;

-- jobs: duplicate_of used in dedup checks
create index jobs_duplicate_of on public.jobs(duplicate_of) where duplicate_of is not null;

-- tenants: owner_id used to look up a user's tenant
create index tenants_owner on public.tenants(owner_id);

-- Fix set_updated_at trigger function: pin search_path to prevent schema-injection
create or replace function public.set_updated_at()
  returns trigger language plpgsql
  set search_path = public
as $$
begin new.updated_at = now(); return new; end $$;
