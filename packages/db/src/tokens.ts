import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ctx } from "@ros/core";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Generates a bearer token. Show `token` to the user ONCE; only `hash` is stored. */
export function generateToken() {
  const token = "ros_" + randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export async function createApiToken(sb: SupabaseClient, ctx: Ctx, label = "mcp") {
  const { token, hash } = generateToken();
  const { error } = await sb.from("api_tokens").insert({ tenant_id: ctx.tenantId, user_id: ctx.userId, token_hash: hash, label });
  if (error) throw new Error("createApiToken: " + error.message);
  return token;
}

/** Resolves a bearer token to a Ctx via its hash; verifies live tenant membership. Returns null if unknown/revoked. */
export async function lookupApiToken(sb: SupabaseClient, token: string): Promise<Ctx | null> {
  const hash = hashToken(token);
  const { data, error } = await sb.from("api_tokens").select("id,tenant_id,user_id").eq("token_hash", hash).is("revoked_at", null).maybeSingle();
  if (error || !data) return null;
  const m = await sb.from("tenant_members").select("user_id").eq("tenant_id", data.tenant_id).eq("user_id", data.user_id).maybeSingle();
  if (!m.data) return null;
  void sb.from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => undefined);
  return { tenantId: data.tenant_id, userId: data.user_id };
}

/** Resolves a Supabase session JWT to the user's (first) tenant. */
export async function resolveSessionCtx(sb: SupabaseClient, jwt: string): Promise<Ctx | null> {
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data.user) return null;
  const m = await sb.from("tenant_members").select("tenant_id").eq("user_id", data.user.id).order("created_at").limit(1).maybeSingle();
  if (!m.data) return null;
  return { tenantId: m.data.tenant_id, userId: data.user.id };
}
