import { getJob } from "../../../../lib/handlers";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return getJob((await params).id)(req);
}
