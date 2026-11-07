import "@/lib/session-init"; // registers the cookie-session resolver before authenticate() runs
import type { Ctx } from "@ros/core";
import { SupabaseStore, SupabaseTaskQueue } from "@ros/db";
import { err, json, UUID_RE, withAuth } from "@/lib/http";
import { getStoreAsync } from "@/lib/store";
import type { ActionDeps, ActionResult } from "./actions";

/** Builds a Next route handler for an exception action: validates the id, authenticates, derives the tenant from the session. */
export function exceptionAction(run: (deps: ActionDeps, ctx: Ctx, id: string) => Promise<ActionResult>) {
  return async (req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
    const { id } = await params;
    if (!UUID_RE.test(id)) return err(400, "invalid_id");
    return withAuth(async (_req, ctx) => {
      const store = await getStoreAsync();
      if (!(store instanceof SupabaseStore)) return err(501, "requires_supabase");
      const sb = store.sb;
      const deps: ActionDeps = {
        store,
        queue: new SupabaseTaskQueue(sb),
        applications: async (c) => {
          const { data, error } = await sb.from("applications").select("id, job_id, status, confirmed").eq("tenant_id", c.tenantId).eq("user_id", c.userId);
          if (error) throw new Error(`applications: ${error.message}`);
          return (data ?? []).map((a: { id: string; job_id: string; status: string; confirmed: boolean }) => ({
            id: String(a.id), jobId: String(a.job_id), status: String(a.status), confirmed: !!a.confirmed,
          }));
        },
      };
      const r = await run(deps, ctx, id);
      return json(r.body, r.status);
    })(req);
  };
}
