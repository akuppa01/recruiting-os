import type { Ctx } from "@ros/core";
import { SupabaseStore, createServiceClient, hasSupabaseEnv, hashToken, lookupApiToken, resolveSessionCtx } from "@ros/db";
import { DEMO_CTX, getStore } from "./store";
import { timingSafeEqual } from "node:crypto";

export type AuthResult = { ok: true; ctx: Ctx; via: "api_token" | "session" | "demo" } | { ok: false; status: 401 | 403; code: string };

/** Hook so Agent D can plug cookie-based sessions (via @supabase/ssr) without touching this file. */
export type SessionResolver = (req: Request) => Promise<Ctx | null>;
let sessionResolver: SessionResolver | null = null;
export function setSessionResolver(fn: SessionResolver | null) { sessionResolver = fn; }

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * Resolution order:
 *  1. Authorization: Bearer <token>
 *     - Supabase configured: sha256(token) looked up in api_tokens (revoked/unknown => try as a Supabase JWT).
 *     - Demo mode: compared (hashed, constant-time) with ROS_API_TOKEN if set.
 *  2. Registered session resolver (cookie session) when present.
 *  3. Demo mode only, ROS_API_TOKEN unset, NODE_ENV != production: open demo tenant.
 */
export async function authenticate(req: Request): Promise<AuthResult> {
  const h = req.headers.get("authorization");
  const bearer = h?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const supa = hasSupabaseEnv();

  if (bearer) {
    if (supa) {
      const store = getStore();
      const sb = store instanceof SupabaseStore ? store.sb : createServiceClient();
      const byToken = await lookupApiToken(sb, bearer);
      if (byToken) return { ok: true, ctx: byToken, via: "api_token" };
      const bySession = await resolveSessionCtx(sb, bearer);
      if (bySession) return { ok: true, ctx: bySession, via: "session" };
      return { ok: false, status: 401, code: "invalid_token" };
    }
    const expected = process.env.ROS_API_TOKEN;
    if (expected && safeEq(hashToken(bearer), hashToken(expected))) return { ok: true, ctx: DEMO_CTX, via: "demo" };
    return { ok: false, status: 401, code: "invalid_token" };
  }

  if (sessionResolver) {
    const ctx = await sessionResolver(req);
    if (ctx) return { ok: true, ctx, via: "session" };
  }

  if (!supa && !process.env.ROS_API_TOKEN && process.env.NODE_ENV !== "production") return { ok: true, ctx: DEMO_CTX, via: "demo" };
  return { ok: false, status: 401, code: "unauthenticated" };
}
