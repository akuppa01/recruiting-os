import type { Ctx } from "@ros/core";
import { authenticate } from "./auth";
import { isDemoMode } from "./store";

export function json(data: unknown, status = 200): Response {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (isDemoMode()) headers["x-ros-demo"] = "1"; // data is in-memory sample data, not persisted
  return new Response(JSON.stringify(data), { status, headers });
}
export const err = (status: number, code: string, detail?: unknown) => json({ error: code, ...(detail !== undefined ? { detail } : {}) }, status);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wraps a handler: authenticates, converts thrown errors into a generic 500 (details logged, never returned). */
export function withAuth(fn: (req: Request, ctx: Ctx) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      const a = await authenticate(req);
      if (!a.ok) return err(a.status, a.code);
      return await fn(req, a.ctx);
    } catch (e) {
      console.error("[api] unhandled", e instanceof Error ? e.message : e);
      return err(500, "internal_error");
    }
  };
}
