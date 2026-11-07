"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Act = "resolve" | "retry" | "skip";
interface Props { id: string; canRetry: boolean; canSkip: boolean; retryBlockedReason: string | null }

const BLOCKED: Record<string, string> = {
  unverified_submission: "A submit may already have gone through. Check your email or the company portal before retrying.",
  already_confirmed: "This application is already confirmed.",
};

/** Go-ahead controls for one inbox item. Each action calls the matching /api/exceptions/[id]/... route and then refreshes the page. */
export function ExceptionActions({ id, canRetry, canSkip, retryBlockedReason }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<Act | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [armedSkip, setArmedSkip] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function run(act: Act) {
    setBusy(act); setMsg(null);
    try {
      const r = await fetch(`/api/exceptions/${id}/${act}`, { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (!r.ok) {
        setMsg({ kind: "err", text: j.detail ?? (r.status === 401 ? "You're not signed in." : r.status === 404 ? "That item no longer exists." : `Couldn't do that (${j.error ?? r.status}).`) });
      } else {
        setMsg({ kind: "ok", text: act === "retry" ? "Queued for another attempt." : act === "skip" ? "Skipped and archived." : "Resolved." });
        router.refresh();
      }
    } catch { setMsg({ kind: "err", text: "Couldn't reach the server." }); }
    finally { setBusy(null); }
  }

  function skip() {
    if (!armedSkip) {
      setArmedSkip(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setArmedSkip(false), 4000);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setArmedSkip(false);
    void run("skip");
  }

  return (
    <div className="w-full sm:w-auto">
      <div className="flex flex-wrap gap-2">
        {canRetry && (
          <button type="button" onClick={() => run("retry")} disabled={busy !== null}
            className="inline-flex items-center justify-center px-4 min-h-[44px] md:min-h-[38px] rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {busy === "retry" ? "Queuing…" : "Retry application"}
          </button>
        )}
        {canSkip && (
          <button type="button" onClick={skip} disabled={busy !== null} className="btn-quiet rounded-xl">
            {busy === "skip" ? "Skipping…" : armedSkip ? "Tap again to skip" : "Skip this job"}
          </button>
        )}
        <button type="button" onClick={() => run("resolve")} disabled={busy !== null} className="btn-quiet rounded-xl">
          {busy === "resolve" ? "Resolving…" : "Mark resolved"}
        </button>
      </div>
      {!canRetry && retryBlockedReason && BLOCKED[retryBlockedReason] && <p className="text-xs text-soft mt-1.5 max-w-sm">{BLOCKED[retryBlockedReason]}</p>}
      {msg && <p role={msg.kind === "err" ? "alert" : "status"} className={`text-xs mt-1.5 ${msg.kind === "err" ? "text-rust" : "text-blue-600 dark:text-blue-400"}`}>{msg.text}</p>}
    </div>
  );
}
