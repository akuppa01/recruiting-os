"use client";
import { useState } from "react";

const ROLES: [string, string][] = [
  ["product_management", "Product management"], ["product_marketing", "Product marketing"], ["gtm_strategy", "GTM strategy"],
  ["founders_office", "Founder's office"], ["bizops_corp_strategy", "Business ops and corporate strategy"], ["growth_brand", "Growth and brand"],
  ["ai_strategy", "AI strategy"], ["strategic_partnerships", "Strategic partnerships"], ["vc_pe_search", "VC, PE portfolio ops and search funds"],
];

export interface PrefsState { roles: string[]; minHourlyUsd: string; locations: string; excluded: string }
export const DEFAULT_PREFS: PrefsState = { roles: ROLES.map((r) => r[0]), minHourlyUsd: "", locations: "", excluded: "" };

export function PrefsForm({ initial = DEFAULT_PREFS, onChange, bare }: { initial?: PrefsState; onChange?: (p: PrefsState) => void; bare?: boolean }) {
  const [p, setP] = useState(initial);
  const [status, setStatus] = useState<"idle" | "busy" | "saved" | "err">("idle");
  const set = (patch: Partial<PrefsState>) => { const n = { ...p, ...patch }; setP(n); setStatus("idle"); onChange?.(n); };
  const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  async function save() {
    setStatus("busy");
    try {
      const body = { roleOrder: p.roles, minHourlyUsd: p.minHourlyUsd ? Number(p.minHourlyUsd) : null, locationsPreferred: split(p.locations), excludedCompanies: split(p.excluded) };
      const r = await fetch("/api/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      setStatus(r.ok ? "saved" : "err");
    } catch { setStatus("err"); }
  }
  const toggle = (k: string) => set({ roles: p.roles.includes(k) ? p.roles.filter((x) => x !== k) : [...p.roles, k] });

  return (
    <div className={bare ? "" : "panel p-5"}>
      <fieldset>
        <legend className="font-serif text-lg mb-2">Roles to pursue</legend>
        <div className="grid sm:grid-cols-2 gap-x-4">
          {ROLES.map(([k, label]) => (
            <label key={k} className="flex items-center gap-3 min-h-[44px] text-sm"><input type="checkbox" checked={p.roles.includes(k)} onChange={() => toggle(k)} />{label}</label>
          ))}
        </div>
      </fieldset>
      <div className="grid sm:grid-cols-3 gap-3 mt-4">
        <label className="text-sm">Minimum hourly pay (USD)<input inputMode="numeric" className="field mt-1" value={p.minHourlyUsd} onChange={(e) => set({ minHourlyUsd: e.target.value.replace(/\D/g, "") })} /></label>
        <label className="text-sm">Preferred locations<input className="field mt-1" placeholder="Remote, New York, Austin" value={p.locations} onChange={(e) => set({ locations: e.target.value })} /></label>
        <label className="text-sm">Companies to skip<input className="field mt-1" placeholder="Comma separated" value={p.excluded} onChange={(e) => set({ excluded: e.target.value })} /></label>
      </div>
      {!bare && (
        <div className="mt-4 flex items-center gap-3">
          <button className="btn" onClick={save} disabled={status === "busy"}>{status === "busy" ? "Saving…" : "Save preferences"}</button>
          <span role="status" className="text-sm">{status === "saved" && <span className="text-teal">Saved.</span>}{status === "err" && <span className="text-rust">Couldn't save. The preferences API isn't available yet, so nothing changed.</span>}</span>
        </div>
      )}
    </div>
  );
}
