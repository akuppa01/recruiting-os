// Private assets (resume PDFs/DOCX, about-me facts, transcript) live in the private Supabase Storage bucket 'resumes' under
// '<user_id>/assets/'. The cloud worker downloads them into a temp dir for the run. Nothing here is ever printed.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const RESUME_BASES = ["PM", "GTM", "Strategy", "Founders_Office"] as const;
export type ResumeBase = (typeof RESUME_BASES)[number];

export interface StorageLike {
  storage: { from(bucket: string): {
    list(path: string, opts?: Record<string, unknown>): Promise<{ data: Array<{ name: string }> | null; error: { message: string } | null }>;
    download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>;
    upload(path: string, body: Uint8Array | Blob | Buffer, opts?: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
  } };
}

export interface AssetBundle {
  dir: string;
  resumes: Record<ResumeBase, { pdf: string; docx: string }>;
  aboutPath: string;
  /** every downloaded file by basename, e.g. the undergraduate transcript PDF */
  files: Record<string, string>;
}

export class MissingAssetsError extends Error {
  constructor(readonly missing: string[], userId: string) {
    super(`Missing private assets in Storage bucket 'resumes' at '${userId}/assets/': ${missing.join(", ")}. Upload them, then re-run.`);
    this.name = "MissingAssetsError";
  }
}

export const requiredAssetNames = (): string[] => [
  ...RESUME_BASES.flatMap((b) => [`${b}_Resume.pdf`, `${b}_Resume.docx`]), "about_me.md",
];

export async function downloadAssets(sb: StorageLike, userId: string, dir: string): Promise<AssetBundle> {
  mkdirSync(dir, { recursive: true });
  const bucket = sb.storage.from("resumes");
  const listed = await bucket.list(`${userId}/assets`, { limit: 100 });
  if (listed.error) throw new Error(`could not list assets: ${listed.error.message}`);
  const names = (listed.data ?? []).map((o) => o.name).filter((n) => !!n && !n.endsWith("/"));
  const missing = requiredAssetNames().filter((n) => !names.includes(n));
  if (missing.length) throw new MissingAssetsError(missing, userId);

  const files: Record<string, string> = {};
  for (const name of names) {
    const r = await bucket.download(`${userId}/assets/${name}`);
    if (r.error || !r.data) throw new Error(`could not download asset ${name}: ${r.error?.message ?? "empty"}`);
    const path = join(dir, basename(name));
    writeFileSync(path, Buffer.from(await r.data.arrayBuffer()));
    files[name] = path;
  }
  const resumes = Object.fromEntries(RESUME_BASES.map((b) => [b, { pdf: files[`${b}_Resume.pdf`]!, docx: files[`${b}_Resume.docx`]! }])) as AssetBundle["resumes"];
  return { dir, resumes, aboutPath: files["about_me.md"]!, files };
}

export interface SavedAnswer { match: string; text: string; pick?: string; file?: string }

/**
 * Saved answers may reference a file by a path from the machine that saved them (e.g. the transcript on the user's Mac).
 * In the cloud the same file is looked up by basename in the downloaded assets; if it isn't there the rule loses its file
 * (so the question surfaces as a specific exception instead of failing silently).
 */
export function resolveAnswerFiles(answers: SavedAnswer[] | undefined, files: Record<string, string>): { answers: SavedAnswer[]; droppedFiles: number } {
  let dropped = 0;
  const out = (answers ?? []).map((a) => {
    if (!a.file) return a;
    const local = files[basename(a.file)];
    if (local) return { ...a, file: local };
    dropped++;
    const { file: _omit, ...rest } = a;
    return rest.pick ? rest : { ...rest, match: "$^never-matches$" }; // a file-only rule without its file must not fall through to text filling
  });
  return { answers: out, droppedFiles: dropped };
}
