"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const STATUSES = [
  { id: "saved", label: "Saved" }, { id: "applied", label: "Applied" }, { id: "interviewing", label: "Interviewing" },
  { id: "offer", label: "Offer" }, { id: "rejected", label: "Rejected" },
] as const;

interface Props { jobId: string; applyUrl: string | null; status: string | null; notes: string; followUpAt: string | null }

export function TrackingPanel({ jobId, applyUrl, status, notes, followUpAt }: Props) {
  const router = useRouter();
  const [n, setN] = useState(notes);
  const [f, setF] = useState(followUpAt ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(body: Record<string, unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/jobs/${jobId}/tracking`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(r.status === 401 ? "You're not signed in." : `Save failed (${r.status}).`);
      setMsg(ok); router.refresh();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Couldn't save."); } finally { setBusy(false); }
  }

  return (
    <div className="mt-5 border-t border-mist pt-4 space-y-4">
      {applyUrl
        ? <a href={applyUrl} target="_blank" rel="noreferrer" className="btn inline-flex">Open application page</a>
        : <p className="text-sm text-soft">No application link was captured for this job.</p>}
      <div>
        <p className="text-sm text-soft mb-2">Status</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Application status">
          {STATUSES.map((s) => (
            <button key={s.id} type="button" disabled={busy} aria-pressed={status === s.id}
              onClick={() => save({ status: status === s.id ? null : s.id }, status === s.id ? "Status cleared." : `Marked ${s.label}.`)}
              className={status === s.id ? "btn" : "btn-quiet"}>{s.label}</button>
          ))}
        </div>
      </div>
      <div>
        <label htmlFor="fu" className="text-sm text-soft block mb-1">Follow-up date</label>
        <input id="fu" type="date" value={f} onChange={(e) => setF(e.target.value)} className="field md:w-48" />
      </div>
      <div>
        <label htmlFor="nt" className="text-sm text-soft block mb-1">Notes</label>
        <textarea id="nt" rows={3} value={n} onChange={(e) => setN(e.target.value)} className="field py-2" maxLength={5000} />
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className="btn" disabled={busy} onClick={() => save({ notes: n, followUpAt: f || null }, "Saved.")}>Save notes and follow-up</button>
        <p role="status" className="text-sm text-soft">{msg}</p>
      </div>
    </div>
  );
}
