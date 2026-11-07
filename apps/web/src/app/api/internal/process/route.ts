import { timingSafeEqual } from "node:crypto";
import { getStoreAsync } from "../../../../lib/store";
import { sweepPending } from "../../../../lib/mvp";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Sweeps ingestions left in `accepted` (e.g. work cut short on a serverless cold stop). Vercel Cron sends CRON_SECRET as a bearer token.
export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const r = await sweepPending(await getStoreAsync(), 20, 45000);
  return Response.json(r);
}
