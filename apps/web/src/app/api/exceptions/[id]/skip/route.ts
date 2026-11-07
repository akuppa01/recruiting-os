import { skipException } from "@/app/api/exceptions/actions";
import { exceptionAction } from "@/app/api/exceptions/route-helper";

export const dynamic = "force-dynamic";
export const POST = exceptionAction(skipException);
