"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface BoardJob { id: string; company: string; title: string; score: number | null; role: string; followUpAt: string | null; col: string }

const COLUMNS = [
  { id: "new", label: "To review" },
  { id: "saved", label: "Saved" },
  { id: "queued", label: "Auto-apply queue", note: "The auto-submit worker is not connected yet. Queued jobs wait here. Open one to apply manually." },
  { id: "applied", label: "Applied" },
  { id: "ready_to_contact", label: "Ready to contact", note: "Applied. Next: reach out to people at the company." },
  { id: "interviewing", label: "Interviewing" },
  { id: "offer", label: "Offer" },
  { id: "rejected", label: "Rejected" },
] as const;

const SELECTABLE = new Set(["new", "saved"]);

export function PipelineBoard({ jobs }: { jobs: BoardJob[] }) {
  const router = useRouter();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function bulk(status: "queued" | "saved") {
    setBusy(true); setMsg(null);
    let ok = 0, fail = 0;
    for (const id of sel) {
      try {
        const r = await fetch(`/api/jobs/${id}/tracking`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
        if (r.ok) ok++; else fail++;
      } catch { fail++; }
    }
    setBusy(false); setSel(new Set());
    setMsg(`${ok} job(s) moved to ${status === "queued" ? "the auto-apply queue" : "Saved"}${fail ? `, ${fail} failed` : ""}.`);
    router.refresh();
  }

  const byScore = (a: BoardJob, b: BoardJob) => (b.score ?? -1) - (a.score ?? -1);

  const card = (j: BoardJob) => (
    <div key={j.id} className="panel rounded-2xl shadow-sm p-3 flex gap-2 items-start hover:border-blue-400">
      {SELECTABLE.has(j.col) && (
        // The label adds the card's padding to the hit area: 20px box + 12px each side = 44px tap target, without changing the layout.
        <label className="shrink-0 -m-3 mr-0 p-3 flex items-start cursor-pointer">
          <input type="checkbox" aria-label={`Select ${j.company}: ${j.title}`} checked={sel.has(j.id)} onChange={() => toggle(j.id)} className="h-5 w-5" />
        </label>
      )}
      <Link href={`/explorer?job=${j.id}`} className="block min-w-0 flex-1">
        <div className="flex justify-between gap-2"><p className="font-medium text-sm">{j.company}</p><span className="tabular-nums text-sm">{j.score ?? "–"}</span></div>
        <p className="text-sm text-soft">{j.title}</p>
        <p className="text-xs text-soft mt-2">{j.role}{j.followUpAt ? ` · follow up ${j.followUpAt}` : ""}</p>
      </Link>
    </div>
  );

  return (
    <>
      {sel.size > 0 && (
        <div className="sticky top-2 z-10 panel rounded-2xl shadow-md p-3 mb-4 flex flex-wrap items-center gap-3" role="region" aria-label="Bulk actions">
          <span className="text-sm">{sel.size} selected</span>
          <button className="btn" disabled={busy} onClick={() => bulk("queued")}>Move to auto-apply queue</button>
          <button className="btn-quiet" disabled={busy} onClick={() => bulk("saved")}>Save</button>
          <button className="btn-quiet" disabled={busy} onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      {msg && <p role="status" className="text-sm mb-3">{msg}</p>}
      <div className="flex flex-col md:flex-row gap-6 md:gap-4 md:overflow-x-auto pb-4">
        {COLUMNS.map((c) => {
          const col = jobs.filter((j) => j.col === c.id).sort(byScore);
          return (
            <section key={c.id} aria-label={c.label} className={`md:w-60 md:shrink-0 ${col.length === 0 ? "hidden md:block" : ""}`}>
              <h2 className="text-sm font-medium pb-2 mb-1 border-b-2 border-ink flex justify-between">{c.label}<span className="text-soft tabular-nums">{col.length}</span></h2>
              {"note" in c && <p className="text-xs text-soft mb-2">{c.note}</p>}
              <div className="space-y-2 mt-2">{col.length ? col.map(card) : <p className="text-xs text-soft">None</p>}</div>
            </section>
          );
        })}
      </div>
    </>
  );
}
