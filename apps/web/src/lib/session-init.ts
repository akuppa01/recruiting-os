/**
 * Wires the cookie-based session resolver into lib/auth.ts.
 * Import this module from any server-side entry point (e.g. handlers.ts)
 * to ensure the resolver is registered before authenticate() is called.
 *
 * Uses AsyncLocalStorage-aware next/headers cookies() — safe to call per-request.
 */
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createServiceClient } from "@ros/db";
import { setSessionResolver } from "./auth";

setSessionResolver(async (_req) => {
  // cookies() is AsyncLocalStorage-scoped to the current request.
  // Outside a Next.js request context (e.g. vitest) it throws; return null safely.
  const cookieStore = await cookies().catch(() => null);
  if (!cookieStore) return null;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {}, // route handlers can't set cookies here; middleware owns refresh
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const sb = createServiceClient();
  const { data: member } = await sb
    .from("tenant_members")
    .select("tenant_id")
    .eq("user_id", user.id)
    .order("created_at")
    .limit(1)
    .maybeSingle();

  if (!member?.tenant_id) return null;
  return { tenantId: member.tenant_id, userId: user.id };
});
