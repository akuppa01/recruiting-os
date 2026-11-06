import type { AutomationPolicy } from "@ros/core";

export type Quiet = AutomationPolicy["quietHours"];

export function localParts(d: Date, tz: string): { hour: number; ymd: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), ymd: `${p.year}-${p.month}-${p.day}` };
}

/** Quiet window [startHour, endHour) in tz; wraps midnight when start > end (e.g. 21 -> 7). */
export function inQuietHours(d: Date, q: Quiet): boolean {
  const { hour } = localParts(d, q.tz);
  return q.startHour > q.endHour ? hour >= q.startHour || hour < q.endHour : hour >= q.startHour && hour < q.endHour;
}

/** First instant >= d outside quiet hours (15-minute steps, max 48h). */
export function nextAllowed(d: Date, q: Quiet): Date {
  let t = new Date(d);
  for (let i = 0; i < 48 * 4 && inQuietHours(t, q); i++) t = new Date(t.getTime() + 15 * 60_000);
  return t;
}

export const DAY_MS = 86_400_000;
