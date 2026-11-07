import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createServiceClient } from "@ros/db";
import type { Ctx } from "@ros/core";

/** Resolves the tenant context from the verified Supabase cookie session. Never trusts client-supplied tenant ids. */
export async function getSessionCtx(): Promise<Ctx | null> {
  const cookieStore = await cookies().catch(() => null);
  if (!cookieStore) return null;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: member } = await createServiceClient()
    .from("tenant_members").select("tenant_id")
    .eq("user_id", user.id).order("created_at").limit(1).maybeSingle();
  if (!member?.tenant_id) return null;
  return { tenantId: member.tenant_id, userId: user.id };
}
