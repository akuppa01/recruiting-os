"use client";
import Link from "next/link";
import { useState } from "react";
import { DEFAULT_POLICY, PolicyForm, type PolicyState } from "./policy-form";
import { DEFAULT_PREFS, PrefsForm, type PrefsState } from "./prefs-form";

interface Item { id: string; name: string; purpose: string; setupUrl: string; configured: boolean }
const STEPS = ["Resume", "Preferences", "Connections", "Automation"] as const;

export function Onboarding({ integrations }: { integrations: Item[] }) {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [prefs, setPrefs] = useState<PrefsState>(DEFAULT_PREFS);
  const [policy, setPolicy] = useState<PolicyState>(DEFAULT_POLICY);
  const [final, setFinal] = useState<"idle" | "busy" | "ok" | "err">("idle");

  async function doUpload() {
    if (!file) return;
    setUpload("busy");
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch("/api/resume", { method: "POST", body: fd });
      setUpload(r.ok ? "ok" : "err");
    } catch { setUpload("err"); }
  }
  async function finish() {
    setFinal("busy");
    const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    try {
      const r = await fetch("/api/preferences", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleOrder: prefs.roles, minHourlyUsd: prefs.minHourlyUsd ? Number(prefs.minHourlyUsd) : null, locationsPreferred: split(prefs.locations), excludedCompanies: split(prefs.excluded), policy }) });
      setFinal(r.ok ? "ok" : "err");
    } catch { setFinal("err"); }
  }

  return (
    <div className="max-w-2xl">
      <ol className="flex gap-2 mb-6" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined} className={`flex-1 pb-2 text-sm border-b-2 ${i === step ? "border-teal font-medium" : i < step ? "border-ink text-soft" : "border-mist text-soft"}`}>{s}</li>
        ))}
      </ol>

      {step === 0 && (
        <section className="panel p-5">
          <h2 className="font-serif text-xl">Upload your resume</h2>
          <p className="text-sm text-soft mt-1 mb-4">Your achievements are read from this file and become the only source for tailored resumes. Nothing is invented.</p>
          <label className="block text-sm">Resume (PDF or DOCX)
            <input type="file" accept=".pdf,.docx" className="field mt-1 py-2" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setUpload("idle"); }} />
          </label>
          <div className="mt-3 flex items-center gap-3">
            <button className="btn" disabled={!file || upload === "busy"} onClick={doUpload}>{upload === "busy" ? "Uploading…" : "Upload resume"}</button>
            <span role="status" className="text-sm">{upload === "ok" && <span className="text-teal">Uploaded.</span>}{upload === "err" && <span className="text-rust">Upload failed. The upload endpoint isn't available yet, so nothing was stored.</span>}</span>
          </div>
        </section>
      )}
      {step === 1 && <section className="panel p-5"><PrefsForm initial={prefs} onChange={setPrefs} bare /></section>}
      {step === 2 && (
        <section className="panel p-5">
          <h2 className="font-serif text-xl mb-3">Connect your accounts</h2>
          <ul className="divide-y divide-mist">
            {integrations.map((i) => (
              <li key={i.id} className="py-3 flex items-center gap-3">
                <span className={`h-2 w-2 rounded-full ${i.configured ? "bg-teal" : "bg-mist"}`} aria-hidden />
                <div className="mr-auto"><p className="font-medium text-sm">{i.name}</p><p className="text-xs text-soft">{i.purpose}</p></div>
                {i.configured ? <span className="text-sm text-teal">Configured</span> : <a className="btn-quiet" href={i.setupUrl} target="_blank" rel="noreferrer">Set up</a>}
              </li>
            ))}
          </ul>
          <p className="text-xs text-soft mt-3">You can finish these later. The system keeps working in dry-run without them.</p>
        </section>
      )}
      {step === 3 && (
        <section className="panel p-5">
          <PolicyForm initial={policy} onChange={setPolicy} bare />
          <div className="mt-5 flex items-center gap-3">
            <button className="btn" onClick={finish} disabled={final === "busy"}>{final === "busy" ? "Saving…" : "Finish setup"}</button>
            <span role="status" className="text-sm">
              {final === "ok" && <span className="text-teal">Saved. <Link className="underline" href="/">Go to Today</Link></span>}
              {final === "err" && <span className="text-rust">Couldn't save. The preferences API isn't available yet, so nothing changed.</span>}
            </span>
          </div>
        </section>
      )}

      <div className="mt-5 flex justify-between">
        <button className="btn-quiet" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        {step < STEPS.length - 1 && <button className="btn" onClick={() => setStep(step + 1)}>Next</button>}
      </div>
    </div>
  );
}
