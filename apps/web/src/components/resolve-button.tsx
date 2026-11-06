"use client";
import { useState } from "react";

export function ResolveButton({ id }: { id: string }) {
  const [s, setS] = useState<"idle" | "busy" | "done" | "err">("idle");
  async function go() {
    setS("busy");
    try {
      const r = await fetch(`/api/exceptions/${id}/resolve`, { method: "POST" });
      setS(r.ok ? "done" : "err");
    } catch { setS("err"); }
  }
  if (s === "done") return <span className="text-sm text-teal">Resolved</span>;
  return (
    <span className="flex items-center gap-2">
      <button onClick={go} disabled={s === "busy"} className="btn-quiet">{s === "busy" ? "Resolving…" : "Mark resolved"}</button>
      {s === "err" && <span role="alert" className="text-xs text-rust">Couldn't resolve. Check that you're signed in and the server is running.</span>}
    </span>
  );
}
