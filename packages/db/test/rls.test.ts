import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MIG = join(__dirname, "../../../supabase/migrations");
const A_USER = randomUUID(), B_USER = randomUUID(), C_USER = randomUUID();
const A_T = randomUUID(), B_T = randomUUID();
const ING = randomUUID(), JOB = randomUUID(), CO = randomUUID(), CT = randomUUID();

let db: PGlite;

async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
async function rlsRejects(uid: string, sql: string) {
  let err: unknown = null;
  try { await as(uid, () => db.exec(sql)); } catch (e) { err = e; }
  expect(err, `expected RLS rejection for: ${sql}`).toBeTruthy();
  expect(String((err as Error).message)).toMatch(/row-level security|violates row-level|permission denied/i);
}

const FULL = ["profiles", "automation_policies", "api_tokens", "feature_flags", "ingestions", "jobs", "companies", "contacts",
  "resume_versions", "cover_letters", "applications", "evidence_items", "outreach_messages", "exceptions", "dead_letters"];
const APPEND = ["events", "external_actions", "usage_events"];
const ALL = [...FULL, ...APPEND];

/** Valid INSERT for `table` under tenant T / user U, referencing A's parent rows. */
function ins(table: string, T: string, U: string, id = randomUUID()): string {
  const u = () => `'${randomUUID()}'`;
  const head = (cols: string, vals: string) => `insert into public.${table}(${cols}) values (${vals})`;
  switch (table) {
    case "profiles": case "automation_policies": return head("tenant_id,user_id", `'${T}','${U}'`);
    case "api_tokens": return head("id,tenant_id,user_id,token_hash", `'${id}','${T}','${U}',${u()}`);
    case "feature_flags": return head("id,tenant_id,user_id,flag", `'${id}','${T}','${U}',${u()}`);
    case "ingestions": return head("id,tenant_id,user_id,request,source", `'${id}','${T}','${U}','{}','manual_text'`);
    case "jobs": return head("id,tenant_id,user_id,ingestion_id,normalized,dedupe_key", `'${id}','${T}','${U}','${ING}','{"company":"c","title":"t"}',${u()}`);
    case "companies": return head("id,tenant_id,user_id,name", `'${id}','${T}','${U}',${u()}`);
    case "contacts": return head("id,tenant_id,user_id,company_id,name", `'${id}','${T}','${U}','${CO}','n'`);
    case "resume_versions": return head("id,tenant_id,user_id,job_id,archetype", `'${id}','${T}','${U}','${JOB}','product_management'`);
    case "cover_letters": return head("id,tenant_id,user_id,job_id,body", `'${id}','${T}','${U}','${JOB}','b'`);
    case "applications": return head("id,tenant_id,user_id,job_id,idempotency_key", `'${id}','${T}','${U}','${JOB}',${u()}`);
    case "evidence_items": return head("id,tenant_id,user_id,slug,employer,role,dates,statement,verified_by,source_doc", `'${id}','${T}','${U}',${u()},'e','r','d','s','resume','x'`);
    case "outreach_messages": return head("id,tenant_id,user_id,contact_id,subject,body", `'${id}','${T}','${U}','${CT}','s','b'`);
    case "events": return head("id,tenant_id,user_id,kind,entity_type", `'${id}','${T}','${U}','k','job'`);
    case "exceptions": return head("id,tenant_id,user_id,type,entity_type,detail", `'${id}','${T}','${U}','captcha','job','d'`);
    case "dead_letters": return head("id,tenant_id,user_id,error", `'${id}','${T}','${U}','boom'`);
    case "external_actions": return head("id,tenant_id,user_id,system,action,status", `'${id}','${T}','${U}','gmail','send','dry_run'`);
    case "usage_events": return head("id,tenant_id,user_id,metric", `'${id}','${T}','${U}','llm.input_tokens'`);
  }
  throw new Error("no fixture for " + table);
}

beforeAll(async () => {
  db = new PGlite();
  // Minimal Supabase shims (auth.uid() driven by a session setting, storage tables, authenticated role).
  await db.exec(`
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role authenticated nologin;
    create table storage.buckets(id text primary key, name text, public boolean default false);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)] $$;
  `);
  for (const f of readdirSync(MIG).filter((x) => x.endsWith(".sql")).sort()) await db.exec(readFileSync(join(MIG, f), "utf8"));
  await db.exec(`
    grant usage on schema public, auth, storage to authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant execute on all functions in schema public to authenticated;
    grant select, insert, update, delete on storage.objects to authenticated;
    grant select on storage.buckets to authenticated;
  `);
  // Service-role style seed (superuser bypasses RLS).
  await db.exec(`
    insert into auth.users(id) values ('${A_USER}'), ('${B_USER}'), ('${C_USER}');
    insert into public.tenants(id,name,owner_id) values ('${A_T}','A','${A_USER}'), ('${B_T}','B','${B_USER}');
    insert into public.tenant_members(tenant_id,user_id) values ('${A_T}','${A_USER}'), ('${B_T}','${B_USER}');
  `);
  await db.exec(ins("ingestions", A_T, A_USER, ING));
  await db.exec(ins("jobs", A_T, A_USER, JOB));
  await db.exec(ins("companies", A_T, A_USER, CO));
  await db.exec(ins("contacts", A_T, A_USER, CT));
  for (const t of ALL) if (!["ingestions", "jobs", "companies", "contacts"].includes(t)) await db.exec(ins(t, A_T, A_USER));
});

const count = async (uid: string, sql: string) => as(uid, async () => Number((await db.query<{ n: string }>(sql)).rows[0]!.n));

describe("migrations apply", () => {
  it("creates every table with RLS enabled", async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and relkind='r'`);
    const rls = Object.fromEntries(r.rows.map((x) => [x.relname, x.relrowsecurity]));
    for (const t of [...ALL, "tenants", "tenant_members"]) expect(rls[t], `${t} must have RLS`).toBe(true);
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true); // no table left unprotected
  });
});

describe("cross-tenant isolation (user B vs user A data)", () => {
  for (const t of ALL) {
    it(`${t}: owner sees own row`, async () => {
      expect(await count(A_USER, `select count(*) n from public.${t} where tenant_id='${A_T}'`)).toBeGreaterThanOrEqual(1);
    });
    it(`${t}: B cannot select A's rows`, async () => {
      expect(await count(B_USER, `select count(*) n from public.${t} where tenant_id='${A_T}'`)).toBe(0);
      expect(await count(B_USER, `select count(*) n from public.${t}`)).toBe(0);
    });
    it(`${t}: B cannot insert into A's tenant (as A or as B)`, async () => {
      await rlsRejects(B_USER, ins(t, A_T, A_USER));
      await rlsRejects(B_USER, ins(t, A_T, B_USER));
    });
    it(`${t}: B cannot insert under own tenant while spoofing user A`, async () => {
      await rlsRejects(B_USER, ins(t, B_T, A_USER));
    });
    it(`${t}: A cannot spoof another user_id inside own tenant`, async () => {
      await rlsRejects(A_USER, ins(t, A_T, B_USER));
    });
    it(`${t}: B cannot update or delete A's rows`, async () => {
      const upd = await as(B_USER, () => db.query(`update public.${t} set updated_at = now() where tenant_id='${A_T}' returning 1`));
      expect(upd.rows).toHaveLength(0);
      const del = await as(B_USER, () => db.query(`delete from public.${t} where tenant_id='${A_T}' returning 1`));
      expect(del.rows).toHaveLength(0);
      expect(await count(A_USER, `select count(*) n from public.${t} where tenant_id='${A_T}'`)).toBeGreaterThanOrEqual(1);
    });
  }

  it("append-only tables: even the owner cannot update or delete", async () => {
    for (const t of APPEND) {
      const upd = await as(A_USER, () => db.query(`update public.${t} set updated_at = now() returning 1`));
      expect(upd.rows).toHaveLength(0);
      const del = await as(A_USER, () => db.query(`delete from public.${t} returning 1`));
      expect(del.rows).toHaveLength(0);
    }
  });

  it("tenants: B cannot read, update, delete or create tenants for A", async () => {
    expect(await count(B_USER, `select count(*) n from public.tenants where id='${A_T}'`)).toBe(0);
    expect((await as(B_USER, () => db.query(`update public.tenants set name='x' where id='${A_T}' returning 1`))).rows).toHaveLength(0);
    expect((await as(B_USER, () => db.query(`delete from public.tenants where id='${A_T}' returning 1`))).rows).toHaveLength(0);
    await rlsRejects(B_USER, `insert into public.tenants(name, owner_id) values ('evil','${B_USER}')`);
  });

  it("tenant_members: B cannot read A's membership or add itself to A's tenant", async () => {
    expect(await count(B_USER, `select count(*) n from public.tenant_members where tenant_id='${A_T}'`)).toBe(0);
    await rlsRejects(B_USER, `insert into public.tenant_members(tenant_id,user_id) values ('${A_T}','${B_USER}')`);
    expect((await as(B_USER, () => db.query(`delete from public.tenant_members where tenant_id='${A_T}' returning 1`))).rows).toHaveLength(0);
    // and a failed escalation attempt didn't grant access
    expect(await count(B_USER, `select count(*) n from public.jobs`)).toBe(0);
  });

  it("storage: users only reach objects under their own user_id folder", async () => {
    await as(A_USER, () => db.exec(`insert into storage.objects(bucket_id,name) values ('resumes','${A_USER}/r.pdf')`));
    expect(await count(A_USER, `select count(*) n from storage.objects`)).toBe(1);
    expect(await count(B_USER, `select count(*) n from storage.objects`)).toBe(0);
    await rlsRejects(B_USER, `insert into storage.objects(bucket_id,name) values ('resumes','${A_USER}/evil.pdf')`);
    await as(B_USER, () => db.exec(`insert into storage.objects(bucket_id,name) values ('ingest-files','${B_USER}/ok.txt')`));
    await rlsRejects(B_USER, `insert into storage.objects(bucket_id,name) values ('public-bucket','${B_USER}/x')`);
  });
});

describe("integrity constraints and helpers", () => {
  it("application cannot be confirmed without evidence", async () => {
    await expect(db.exec(`update public.applications set confirmed = true where job_id='${JOB}'`)).rejects.toThrow(/confirmed_needs_evidence|check constraint/i);
    await db.exec(`update public.applications set confirmed = true, status='succeeded', evidence='{"kind":"api_response"}' where job_id='${JOB}'`);
  });
  it("one application per tenant+job", async () => {
    await expect(db.exec(ins("applications", A_T, A_USER))).rejects.toThrow(/unique|duplicate/i);
  });
  it("jobs dedupe key is unique among non-duplicates", async () => {
    const k = randomUUID();
    const i2 = randomUUID(), i3 = randomUUID();
    await db.exec(ins("ingestions", A_T, A_USER, i2)); await db.exec(ins("ingestions", A_T, A_USER, i3));
    const j = (id: string, ing: string, dup = "null") => `insert into public.jobs(id,tenant_id,user_id,ingestion_id,normalized,dedupe_key,duplicate_of) values ('${id}','${A_T}','${A_USER}','${ing}','{"company":"c","title":"t"}','${k}',${dup})`;
    const first = randomUUID();
    await db.exec(j(first, i2));
    await expect(db.exec(j(randomUUID(), i3))).rejects.toThrow(/unique|duplicate/i);
    await db.exec(j(randomUUID(), i3, `'${first}'`)); // allowed when flagged duplicate
  });
  it("idempotency key unique per tenant+user for ingestions", async () => {
    const s = (k: string) => `insert into public.ingestions(tenant_id,user_id,request,source,idempotency_key) values ('${A_T}','${A_USER}','{}','mcp','${k}')`;
    await db.exec(s("dup-key"));
    await expect(db.exec(s("dup-key"))).rejects.toThrow(/unique|duplicate/i);
  });
  it("updated_at trigger fires", async () => {
    const before = (await db.query<{ u: string }>(`select updated_at::text u from public.companies where id='${CO}'`)).rows[0]!.u;
    await db.exec(`select pg_sleep(0.01); update public.companies set name = name || 'x' where id='${CO}'`);
    const after = (await db.query<{ u: string }>(`select updated_at::text u from public.companies where id='${CO}'`)).rows[0]!.u;
    expect(after).not.toBe(before);
  });
  it("bootstrap_tenant creates tenant, membership, profile and dry_run policy for the caller", async () => {
    await db.exec(`insert into auth.users(id) values ('${randomUUID()}')`); // noop sanity
    const tid = await as(C_USER, async () => (await db.query<{ t: string }>(`select public.bootstrap_tenant('C Co') t`)).rows[0]!.t);
    expect(await count(C_USER, `select count(*) n from public.tenant_members where tenant_id='${tid}'`)).toBe(1);
    const pol = await as(C_USER, async () => (await db.query<{ p: { mode: string; autoApply: boolean } }>(`select policy p from public.automation_policies where tenant_id='${tid}'`)).rows[0]!.p);
    expect(pol.mode).toBe("dry_run");
    expect(pol.autoApply).toBe(false);
    expect(await count(A_USER, `select count(*) n from public.tenants where id='${tid}'`)).toBe(0);
  });
  it("bootstrap_tenant rejects unauthenticated callers", async () => {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
    await expect(db.query(`select public.bootstrap_tenant('x')`)).rejects.toThrow(/not authenticated/);
    await db.exec("reset role");
  });
});
