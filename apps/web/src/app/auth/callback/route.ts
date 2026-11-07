import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@ros/db";

const ALLOWED_NEXT_PATHS = /^\/[a-zA-Z0-9\-_/]*$/;

function safeNext(raw: string | null, fallback = "/"): string {
  if (!raw) return fallback;
  try {
    if (raw.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(raw)) {
      return fallback;
    }
    if (!ALLOWED_NEXT_PATHS.test(raw)) return fallback;
    return raw;
  } catch {
    return fallback;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const origin = request.nextUrl.origin;
  const next = safeNext(searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  // Build the redirect response FIRST so setAll can attach session cookies to it.
  const redirectResponse = NextResponse.redirect(`${origin}${next}`);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) =>
            redirectResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    console.error("[auth/callback] exchange failed:", error?.message);
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  const user = data.user;
  const email = user.email ?? "";
  const provider = user.app_metadata?.provider ?? "google";

  // Bootstrap tenant (idempotent — no-ops if the user already has one).
  // Use service client for privileged operations; user session is already set.
  const sb = createServiceClient();

  const { error: bootErr } = await supabase.rpc("bootstrap_tenant", {
    p_name: email.split("@")[0] ?? "my-workspace",
  });
  if (bootErr) {
    console.error("[auth/callback] bootstrap_tenant error:", bootErr.message);
  }

  const { data: member } = await sb
    .from("tenant_members")
    .select("tenant_id")
    .eq("user_id", user.id)
    .order("created_at")
    .limit(1)
    .maybeSingle();

  if (member?.tenant_id) {
    await sb
      .from("profiles")
      .update({ recruiting_email: email, auth_provider: provider })
      .eq("tenant_id", member.tenant_id)
      .eq("user_id", user.id);
  }

  return redirectResponse;
}
