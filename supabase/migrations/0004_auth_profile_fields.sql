-- 0004_auth_profile_fields.sql
-- Add recruiting_email and auth_provider to profiles.
-- Make bootstrap_tenant idempotent: re-entrant on second login.

alter table public.profiles
  add column if not exists recruiting_email text,
  add column if not exists auth_provider   text;

-- Replace bootstrap_tenant with an idempotent version.
-- If the calling user already belongs to a tenant, return that tenant's id.
create or replace function public.bootstrap_tenant(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  -- Idempotency: return existing tenant if the user is already a member.
  select tenant_id into t
    from public.tenant_members
   where user_id = auth.uid()
   order by created_at
   limit 1;

  if t is not null then
    return t;
  end if;

  insert into public.tenants(name, owner_id) values (p_name, auth.uid()) returning id into t;
  insert into public.tenant_members(tenant_id, user_id, role) values (t, auth.uid(), 'owner');
  insert into public.profiles(tenant_id, user_id) values (t, auth.uid());
  insert into public.automation_policies(tenant_id, user_id) values (t, auth.uid());
  return t;
end $$;
