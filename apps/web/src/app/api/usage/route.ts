import "@/lib/session-init"; // registers the cookie-session resolver before authenticate() runs
import { SupabaseStore } from "@ros/db";
import { computeUsage } from "@/lib/data";
import { json, withAuth } from "@/lib/http";
import { getStoreAsync } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/usage: measured vs estimated AI usage, spend against limits, application and browser counts, n8n estimate. Tenant from the session.
export const GET = withAuth(async (_req, ctx) => {
  const store = await getStoreAsync();
  if (!(store instanceof SupabaseStore)) return json({ error: "requires_supabase" }, 501);
  return json(await computeUsage(store.sb, ctx));
});
