import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const ALLOWED_NEXT_PATHS = /^\/[a-zA-Z0-9\-_/]*$/;

function safeNext(raw: string | null, fallback = "/"): string {
  if (!raw) return fallback;
  try {
    // Reject anything that looks like an absolute URL or protocol-relative URL.
    if (raw.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(raw)) {
      return fallback;
    }
    if (!ALLOWED_NEXT_PATHS.test(raw)) return fallback;
    return raw;
  } catch {
    return fallback;
  }
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    console.error("[auth/callback] exchange failed:", error?.message);
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  const user = data.user;
  const email = user.email ?? "";
  const provider = user.app_metadata?.provider ?? "google";

  // Bootstrap tenant (idempotent — no-ops if the user already has one).
  const { error: bootErr } = await supabase.rpc("bootstrap_tenant", {
    p_name: email.split("@")[0] ?? "my-workspace",
  });
  if (bootErr) {
    console.error("[auth/callback] bootstrap_tenant error:", bootErr.message);
  }

  // Upsert profile fields — tenant_id is resolved via first tenant_members row.
  const { data: member } = await supabase
    .from("tenant_members")
    .select("tenant_id")
    .eq("user_id", user.id)
    .order("created_at")
    .limit(1)
    .maybeSingle();

  if (member?.tenant_id) {
    await supabase
      .from("profiles")
      .update({ recruiting_email: email, auth_provider: provider })
      .eq("tenant_id", member.tenant_id)
      .eq("user_id", user.id);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
