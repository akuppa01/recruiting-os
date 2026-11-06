export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: { attempts: number; baseDelayMs: number; sleep: (ms: number) => Promise<void> }): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= o.attempts; i++) {
    try { return await fn(i); } catch (e) {
      last = e;
      if (i < o.attempts) await o.sleep(o.baseDelayMs * 2 ** (i - 1));
    }
  }
  throw Object.assign(new Error(last instanceof Error ? last.message : String(last)), { cause: last, attempts: o.attempts });
}
export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
