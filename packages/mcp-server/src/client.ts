// Thin HTTP client to the ROS API. Never fabricates: on any failure it throws RosApiError.
export class RosApiError extends Error {
  constructor(message: string, public status: number | null, public body?: unknown) { super(message); }
}
export interface ClientOpts { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }

export class RosClient {
  private f: typeof fetch;
  constructor(private o: ClientOpts) { this.f = o.fetchImpl ?? fetch; }

  async call(method: "GET" | "POST" | "PATCH", path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<unknown> {
    if (!this.o.baseUrl) throw new RosApiError("ROS_API_BASE_URL is not set", null);
    if (!this.o.token) throw new RosApiError("ROS_API_TOKEN is not set (create a per-user token in Recruiting OS → Settings)", null);
    const u = new URL(path, this.o.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await this.f(u, {
        method,
        headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json", accept: "application/json" },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 20000),
      });
    } catch (e) {
      throw new RosApiError(`Recruiting OS API unreachable at ${this.o.baseUrl}: ${(e as Error).message}`, null);
    }
    const text = await res.text();
    let json: unknown = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
    if (!res.ok) throw new RosApiError(`API ${method} ${u.pathname} failed with HTTP ${res.status}`, res.status, json ?? text);
    return json;
  }
}
