import type { ReactNode } from "react";

const TONES = {
  neutral: "border-mist text-soft",
  good: "border-teal text-teal",
  warn: "border-amber text-amber",
  bad: "border-rust text-rust",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-block text-xs px-1.5 py-0.5 border rounded-board whitespace-nowrap ${TONES[tone]}`}>{children}</span>;
}

export function PageHeader({ title, lede, right }: { title: string; lede?: string; right?: ReactNode }) {
  return (
    <header className="flex items-end justify-between gap-4 mb-6">
      <div>
        <h1 className="page-title">{title}</h1>
        {lede && <p className="text-soft mt-1 max-w-prose">{lede}</p>}
      </div>
      {right}
    </header>
  );
}

export function Empty({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="panel p-8 text-center">
      <p className="font-serif text-xl">{title}</p>
      {action && <div className="mt-4 text-sm text-soft">{action}</div>}
    </div>
  );
}

export function Score({ value }: { value: number | null }) {
  if (value == null) return <span className="text-soft text-sm">Unscored</span>;
  const tone = value >= 80 ? "text-teal" : value >= 60 ? "text-ink" : "text-soft";
  return <span className={`font-serif text-lg tabular-nums ${tone}`} aria-label={`Score ${value} of 100`}>{value}</span>;
}

export function DemoBanner() {
  return (
    <div role="status" className="bg-amber/15 border-b border-amber text-sm px-4 py-2 text-ink">
      <strong className="font-semibold">Demo data.</strong> Everything shown here is fictional. Connect Supabase to see your own pipeline.
    </div>
  );
}

export function ModeBadge({ mode }: { mode: "dry_run" | "live" }) {
  return mode === "live" ? <Badge tone="warn">Live</Badge> : <Badge>Dry run</Badge>;
}
