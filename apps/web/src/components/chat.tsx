"use client";
import { useRef, useState } from "react";

interface Msg { role: "you" | "chief" | "system"; text: string }

export function Chat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = v.trim();
    if (!text || busy) return;
    setMsgs((m) => [...m, { role: "you", text }]);
    setV(""); setBusy(true);
    try {
      const r = await fetch("/api/chief-of-staff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text }) });
      if (!r.ok) throw new Error(r.status === 404 ? "The Chief of Staff service isn't deployed yet. Your message wasn't processed." : `The service returned an error (${r.status}).`);
      const j = (await r.json()) as { reply?: string };
      setMsgs((m) => [...m, { role: "chief", text: j.reply ?? "The service returned an empty reply." }]);
    } catch (err) {
      setMsgs((m) => [...m, { role: "system", text: err instanceof Error ? err.message : "Couldn't reach the service." }]);
    } finally {
      setBusy(false);
      setTimeout(() => end.current?.scrollIntoView({ block: "end" }), 0);
    }
  }

  return (
    <div className="panel flex flex-col h-[calc(100dvh-16rem)] md:h-[calc(100vh-14rem)] min-h-[320px]">
      <div className="flex-1 overflow-y-auto p-4 space-y-3" role="log" aria-live="polite" aria-label="Conversation">
        {msgs.length === 0 && <p className="text-soft text-sm">Ask what changed today, which roles to prioritize, or what is stuck. Answers come from your database.</p>}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "you" ? "text-right" : ""}>
            <p className={`inline-block max-w-[85%] text-left text-sm px-3 py-2 rounded-board ${m.role === "you" ? "bg-ink text-chalk" : m.role === "system" ? "border border-rust text-rust" : "border border-mist"}`}>{m.text}</p>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="border-t border-mist p-3 flex gap-2">
        <label htmlFor="chat" className="sr-only">Message</label>
        <input id="chat" value={v} onChange={(e) => setV(e.target.value)} placeholder="Ask your Chief of Staff" className="field" />
        <button className="btn" disabled={busy || !v.trim()}>{busy ? "Sending…" : "Send"}</button>
      </form>
    </div>
  );
}
