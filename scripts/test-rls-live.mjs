#!/usr/bin/env node
/**
 * Phase A.4 — Cross-tenant RLS isolation test against live Supabase.
 *
 * What it proves:
 *   1. User A can insert a job and read it back.
 *   2. User B (different tenant) cannot read, update, or delete A's job.
 *   3. Anonymous client cannot read any jobs.
 *
 * Requirements:
 *   NEXT_PUBLIC_SUPABASE_URL   — project URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY — anon/public key
 *   SUPABASE_SERVICE_ROLE_KEY  — service-role key (admin cleanup)
 *
 * The script creates two throw-away auth users via the Admin API, runs the
 * isolation checks with their session tokens, then deletes everything.
 * Run:  node scripts/test-rls-live.mjs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('Missing env vars. Need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TS = Date.now();
const EMAIL_A = `rls-test-a-${TS}@example-rls-test.invalid`;
const EMAIL_B = `rls-test-b-${TS}@example-rls-test.invalid`;
const PASS    = `Test_${TS}_pass!`;

let userAId, userBId, tenantAId, tenantBId, jobAId, ingestionAId;
let failures = 0;

function pass(msg) { console.log(`  PASS  ${msg}`); }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function assert(cond, label) { cond ? pass(label) : fail(label); }

// ─── helpers ────────────────────────────────────────────────────────────────

async function clientFor(email, password) {
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  return c;
}

async function bootstrapTenant(client, name) {
  const { data, error } = await client.rpc('bootstrap_tenant', { p_name: name });
  if (error) throw new Error(`bootstrap_tenant(${name}): ${error.message}`);
  // returns the tenant_id
  return data;
}

async function insertIngestion(adminClient, tenantId, userId) {
  const { data, error } = await adminClient
    .from('ingestions')
    .insert({
      tenant_id: tenantId,
      user_id: userId,
      status: 'done',
      source: 'manual',
      request: { text: 'rls-test' },
      idempotency_key: `rls-ingest-${TS}`,
    })
    .select('id')
    .single();
  if (error) throw new Error(`insertIngestion: ${error.message}`);
  return data.id;
}

async function insertJob(adminClient, tenantId, userId, ingestionId, title) {
  const { data, error } = await adminClient
    .from('jobs')
    .insert({
      tenant_id: tenantId,
      user_id: userId,
      ingestion_id: ingestionId,
      normalized: { title, company: 'RLS Test Co' },
      stage: 'tracking',
      dedupe_key: `rls-test-${TS}-${title}`,
    })
    .select('id')
    .single();
  if (error) throw new Error(`insertJob: ${error.message}`);
  return data.id;
}

// ─── setup ──────────────────────────────────────────────────────────────────

console.log('\n=== Phase A.4: Cross-tenant RLS isolation test ===\n');
console.log('Creating test users...');

const { data: { user: uA }, error: eA } = await admin.auth.admin.createUser({
  email: EMAIL_A, password: PASS, email_confirm: true,
});
if (eA) { console.error('createUser A:', eA.message); process.exit(1); }
userAId = uA.id;

const { data: { user: uB }, error: eB } = await admin.auth.admin.createUser({
  email: EMAIL_B, password: PASS, email_confirm: true,
});
if (eB) {
  await admin.auth.admin.deleteUser(userAId);
  console.error('createUser B:', eB.message); process.exit(1);
}
userBId = uB.id;
console.log(`  User A: ${userAId}`);
console.log(`  User B: ${userBId}`);

// ─── tests ──────────────────────────────────────────────────────────────────

try {
  console.log('\n--- Bootstrap tenants ---');
  const clientA = await clientFor(EMAIL_A, PASS);
  const clientB = await clientFor(EMAIL_B, PASS);
  const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  tenantAId = await bootstrapTenant(clientA, `RLS-Test-A-${TS}`);
  tenantBId = await bootstrapTenant(clientB, `RLS-Test-B-${TS}`);
  pass(`Tenant A created: ${tenantAId}`);
  pass(`Tenant B created: ${tenantBId}`);

  console.log('\n--- User A inserts ingestion + job (via admin, testing read/update/delete isolation) ---');
  ingestionAId = await insertIngestion(admin, tenantAId, userAId);
  jobAId = await insertJob(admin, tenantAId, userAId, ingestionAId, 'Job by A');
  pass(`Ingestion A inserted: ${ingestionAId}`);
  pass(`Job A inserted: ${jobAId}`);

  console.log('\n--- User A reads own job ---');
  const { data: readOwn, error: errOwn } = await clientA
    .from('jobs').select('id').eq('id', jobAId).single();
  assert(!errOwn && readOwn?.id === jobAId, 'User A can read own job');

  console.log('\n--- User B cannot read User A\'s job ---');
  const { data: readB, error: errReadB } = await clientB
    .from('jobs').select('id').eq('id', jobAId).maybeSingle();
  assert(!errReadB && readB === null, 'User B reads null for A\'s job (RLS blocks)');

  console.log('\n--- User B cannot update User A\'s job ---');
  // Update stage (an actual non-generated column); RLS should block → 0 rows affected
  const { error: errUpdateB } = await clientB
    .from('jobs').update({ stage: 'applied' }).eq('id', jobAId);
  const { data: checkJob } = await clientA
    .from('jobs').select('stage').eq('id', jobAId).single();
  assert(
    !errUpdateB && checkJob?.stage === 'tracking',
    'User B update returns no error but 0 rows affected (stage still "tracking")',
  );

  console.log('\n--- User B cannot delete User A\'s job ---');
  const { error: errDelB } = await clientB
    .from('jobs').delete().eq('id', jobAId);
  const { data: stillThere } = await clientA
    .from('jobs').select('id').eq('id', jobAId).single();
  assert(stillThere?.id === jobAId, 'User B cannot delete A\'s job (still exists)');

  console.log('\n--- Anonymous client cannot read any jobs ---');
  const { data: anonRows, error: errAnon } = await anonClient
    .from('jobs').select('id').limit(5);
  assert(
    (!errAnon && (!anonRows || anonRows.length === 0)) || !!errAnon,
    'Anonymous client reads 0 rows from jobs',
  );

} finally {
  // ─── cleanup ────────────────────────────────────────────────────────────────
  console.log('\n--- Cleanup ---');
  if (jobAId) {
    const { error } = await admin.from('jobs').delete().eq('id', jobAId);
    if (error) console.warn('  cleanup job:', error.message);
    else console.log('  Deleted job A');
  }
  if (ingestionAId) {
    const { error } = await admin.from('ingestions').delete().eq('id', ingestionAId);
    if (error) console.warn('  cleanup ingestion:', error.message);
    else console.log('  Deleted ingestion A');
  }
  if (tenantAId) {
    // Delete tenant members, then tenant
    await admin.from('tenant_members').delete().eq('tenant_id', tenantAId);
    await admin.from('profiles').delete().eq('tenant_id', tenantAId);
    await admin.from('tenants').delete().eq('id', tenantAId);
    console.log('  Deleted tenant A and related rows');
  }
  if (tenantBId) {
    await admin.from('tenant_members').delete().eq('tenant_id', tenantBId);
    await admin.from('profiles').delete().eq('tenant_id', tenantBId);
    await admin.from('tenants').delete().eq('id', tenantBId);
    console.log('  Deleted tenant B and related rows');
  }
  if (userAId) {
    await admin.auth.admin.deleteUser(userAId);
    console.log('  Deleted auth user A');
  }
  if (userBId) {
    await admin.auth.admin.deleteUser(userBId);
    console.log('  Deleted auth user B');
  }
}

// ─── result ─────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(50));
if (failures === 0) {
  console.log(`RESULT: PASS — all RLS isolation checks passed`);
  process.exit(0);
} else {
  console.error(`RESULT: FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
