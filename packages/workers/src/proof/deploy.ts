import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

export type DeployStatus = "succeeded" | "unverified" | "dry_run" | "failed";
export interface DeployResult { status: DeployStatus; url: string | null; localPath: string; detail: string }
export interface DeployAdapter { name: string; deploy(localDir: string): Promise<DeployResult> }
type Exec = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => Promise<{ stdout: string }>;

/** Shells to the `vercel` CLI ONLY when VERCEL_TOKEN is set (read from env, never argv/logs). Never fabricates a URL. */
export class VercelAdapter implements DeployAdapter {
  name = "vercel";
  constructor(private env: NodeJS.ProcessEnv = process.env, private exec: Exec = (c, a, o) => run(c, a, o) as Promise<{ stdout: string }>) {}
  async deploy(localDir: string): Promise<DeployResult> {
    if (!this.env.VERCEL_TOKEN) return { status: "dry_run", url: null, localPath: localDir, detail: "VERCEL_TOKEN not set; page written locally only" };
    try {
      const { stdout } = await this.exec("vercel", ["deploy", "--yes", "--public"], { env: this.env, cwd: localDir });
      const m = stdout.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app/i);
      return m
        ? { status: "unverified", url: m[0], localPath: localDir, detail: "CLI printed a URL; reachability not checked (call verifyUrl)" }
        : { status: "unverified", url: null, localPath: localDir, detail: "CLI finished but no URL found in output" };
    } catch (e) {
      return { status: "failed", url: null, localPath: localDir, detail: String((e as Error).message).replace(this.env.VERCEL_TOKEN ?? "\u0000", "***") };
    }
  }
}

/** Upgrade 'unverified' to 'succeeded' only if the URL actually answers 200. */
export async function verifyUrl(r: DeployResult, fetchFn: typeof fetch = fetch): Promise<DeployResult> {
  if (!r.url) return r;
  try {
    const res = await fetchFn(r.url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? { ...r, status: "succeeded", detail: "URL returned 200" } : { ...r, detail: `URL returned ${res.status}` };
  } catch { return { ...r, detail: "URL not reachable yet" }; }
}

export async function deployPreview(localDir: string, adapter: DeployAdapter = new VercelAdapter()): Promise<DeployResult> {
  return adapter.deploy(localDir);
}
