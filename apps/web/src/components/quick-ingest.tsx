"use client";
import { useState } from "react";

type State = { kind: "idle" } | { kind: "busy" } | { kind: "ok"; id: string } | { kind: "err"; msg: string };

export function QuickIngest() {
  const [value, setValue] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    setState({ kind: "busy" });
    const isUrl = /^https?:\/\/\S+$/.test(v);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(isUrl ? { source: "manual_url", url: v } : { source: "manual_text", text: v }),
      });
      if (!res.ok) throw new Error(res.status === 401 ? "You're not signed in." : res.status === 404 ? "The ingest endpoint isn't deployed." : `Ingest failed (${res.status}).`);
      const json = (await res.json()) as { ingestionId?: string };
      if (!json.ingestionId) throw new Error("The server accepted the request but returned no ingestion ID.");
      setState({ kind: "ok", id: json.ingestionId });
      setValue("");
    } catch (err) {
      setState({ kind: "err", msg: err instanceof Error ? err.message : "Couldn't reach the server." });
    }
  }

  return (
    <form onSubmit={submit} className="panel p-4" aria-label="Add a job">
      <label htmlFor="qi" className="block font-serif text-lg mb-2">Add a job</label>
      <textarea id="qi" rows={2} value={value} onChange={(e) => setValue(e.target.value)}
        placeholder="Paste a job link or the full description" className="field py-2" />
      <div className="mt-3 flex items-center gap-3">
        <button className="btn" disabled={state.kind === "busy" || !value.trim()}>{state.kind === "busy" ? "Adding…" : "Add job"}</button>
        <p role="status" className="text-sm">
          {state.kind === "ok" && <span className="text-teal">Added. Ingestion {state.id.slice(0, 8)} is processing.</span>}
          {state.kind === "err" && <span className="text-rust">{state.msg} Nothing was saved.</span>}
        </p>
      </div>
    </form>
  );
}
