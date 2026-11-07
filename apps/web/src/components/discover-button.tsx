"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Summary { boards: number; boardErrors: string[]; matched: number; imported: number; alreadyHad: number; failed: number; deferred: number }

export function DiscoverButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<string | null>(null);

  async function run() {
    setBusy(true); setRes(null);
    try {
      const r = await fetch("/api/discover", { method: "POST" });
      if (!r.ok) throw new Error(r.status === 401 ? "You're not signed in." : `Discovery failed (${r.status}).`);
      const s = (await r.json()) as Summary;
      setRes(`Checked ${s.boards} company boards: ${s.matched} matching roles, ${s.imported} new, ${s.alreadyHad} already had${s.deferred ? `, ${s.deferred} left for the next run` : ""}${s.failed ? `, ${s.failed} failed` : ""}${s.boardErrors.length ? `. ${s.boardErrors.length} board(s) unavailable` : ""}.`);
      router.refresh();
    } catch (e) { setRes(e instanceof Error ? e.message : "Couldn't reach the server."); } finally { setBusy(false); }
  }

  return (
    <div className="panel p-4">
      <p className="font-serif text-lg mb-1">Find jobs</p>
      <p className="text-sm text-soft mb-3">Scans public company job boards for Summer 2027 internships and fellowships in product management, GTM, strategy, product marketing, partnerships and business operations (Remote, TX, NY, CA, FL).</p>
      <div className="flex items-center gap-3">
        <button type="button" className="btn" onClick={run} disabled={busy}>{busy ? "Searching (up to a minute)…" : "Find jobs now"}</button>
        <p role="status" className="text-sm">{res}</p>
      </div>
    </div>
  );
}
