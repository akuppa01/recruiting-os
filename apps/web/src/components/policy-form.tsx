"use client";
import { useState } from "react";

export interface PolicyState { mode: "dry_run" | "live"; autoApply: boolean; autoOutreach: boolean; minScoreToApply: number; maxApplicationsPerDay: number; maxOutreachPerDay: number }
export const DEFAULT_POLICY: PolicyState = { mode: "dry_run", autoApply: false, autoOutreach: false, minScoreToApply: 65, maxApplicationsPerDay: 15, maxOutreachPerDay: 20 };

export function PolicyForm({ initial = DEFAULT_POLICY, onChange, bare }: { initial?: PolicyState; onChange?: (p: PolicyState) => void; bare?: boolean }) {
  const [p, setP] = useState(initial);
  const [status, setStatus] = useState<"idle" | "busy" | "saved" | "err">("idle");
  const set = (patch: Partial<PolicyState>) => { const n = { ...p, ...patch }; setP(n); setStatus("idle"); onChange?.(n); };

  async function save() {
    setStatus("busy");
    try {
      const r = await fetch("/api/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy: p }) });
      setStatus(r.ok ? "saved" : "err");
    } catch { setStatus("err"); }
  }
  const live = p.mode === "live";

  return (
    <div className={bare ? "" : "panel p-5"}>
      <fieldset>
        <legend className="font-serif text-lg mb-2">Automation mode</legend>
        <div className="grid sm:grid-cols-2 gap-3">
          {(["dry_run", "live"] as const).map((m) => (
            <label key={m} className={`flex gap-3 p-3 border rounded-board cursor-pointer min-h-[44px] ${p.mode === m ? "border-teal bg-chalk" : "border-mist"}`}>
              <input type="radio" name="mode" checked={p.mode === m} onChange={() => set({ mode: m, ...(m === "dry_run" ? { autoApply: false, autoOutreach: false } : {}) })} />
              <span><span className="block font-medium text-sm">{m === "dry_run" ? "Dry run" : "Live"}</span><span className="block text-sm text-soft">{m === "dry_run" ? "Prepare everything. Send and submit nothing." : "Submit applications and send email under the rules below."}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      {live && (
        <p role="alert" className="mt-3 text-sm border border-amber text-ink bg-amber/10 rounded-board p-3">
          Live mode sends real applications and email from your accounts. Turn it on only after you've checked a dry-run result and the matching integration shows as connected.
        </p>
      )}
      <div className="mt-4 space-y-2">
        <label className="flex items-center gap-3 min-h-[44px]"><input type="checkbox" disabled={!live} checked={p.autoApply} onChange={(e) => set({ autoApply: e.target.checked })} /><span className="text-sm">Apply automatically to qualifying jobs</span></label>
        <label className="flex items-center gap-3 min-h-[44px]"><input type="checkbox" disabled={!live} checked={p.autoOutreach} onChange={(e) => set({ autoOutreach: e.target.checked })} /><span className="text-sm">Send outreach and follow-ups automatically</span></label>
        {!live && <p className="text-xs text-soft">These switches are off until you choose live mode.</p>}
      </div>
      <div className="grid sm:grid-cols-3 gap-3 mt-4">
        {([["minScoreToApply", "Minimum score to apply"], ["maxApplicationsPerDay", "Applications per day"], ["maxOutreachPerDay", "Outreach emails per day"]] as const).map(([k, label]) => (
          <label key={k} className="text-sm">{label}
            <input type="number" min={0} max={100} className="field mt-1" value={p[k]} onChange={(e) => set({ [k]: Number(e.target.value) } as Partial<PolicyState>)} />
          </label>
        ))}
      </div>
      {!bare && (
        <div className="mt-4 flex items-center gap-3">
          <button className="btn" onClick={save} disabled={status === "busy"}>{status === "busy" ? "Saving…" : "Save policy"}</button>
          <span role="status" className="text-sm">{status === "saved" && <span className="text-teal">Saved.</span>}{status === "err" && <span className="text-rust">Couldn't save. The preferences API isn't available yet, so nothing changed.</span>}</span>
        </div>
      )}
    </div>
  );
}
