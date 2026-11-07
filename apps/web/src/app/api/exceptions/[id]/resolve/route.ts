import { resolveExceptionHandler } from "../../../../../lib/handlers";
export const dynamic = "force-dynamic";
export const POST = async (req: Request, { params }: { params: Promise<{ id: string }> }) =>
  resolveExceptionHandler((await params).id)(req);
