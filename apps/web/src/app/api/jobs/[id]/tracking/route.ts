import { putTracking } from "../../../../../lib/handlers";
export const dynamic = "force-dynamic";
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return putTracking((await params).id)(req);
}
