import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const { origin } = new URL(request.url);
  return NextResponse.redirect(`${origin}/login`, { status: 302 });
}

// Allow GET for simple <a href="/auth/logout"> links as well, since
// sign-out has no meaningful side effects beyond clearing the user's own cookie.
export async function GET(request: Request) {
  return POST(request);
}
