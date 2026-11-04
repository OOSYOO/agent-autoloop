import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicFile, canonical, hash } from "./storage.ts";
type Kind = "reports" | "manifests";
export function saveArtifact(root: string, kind: Kind, value: unknown): string {
  const text = canonical(value),
    digest = hash(text),
    file = join(root, kind, `${digest}.json`);
  try {
    atomicFile(file, text, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(file, "utf8") !== text) throw error;
  }
  return digest;
}
export function loadArtifact(root: string, kind: Kind, digest: string): unknown {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("摘要无效");
  const text = readFileSync(join(root, kind, `${digest}.json`), "utf8");
  if (hash(text) !== digest) throw new Error("文件内容与摘要不符");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { schema?: unknown }).schema !== 1)
    throw new Error("文件版本无效");
  return value;
}
export function completedReport(
  root: string,
  projectId: number,
  mrIid: number,
  headSha: string,
  policyHash: string,
): { hash: string; value: any } | null {
  let names: string[];
  try {
    names = readdirSync(join(root, "reports"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const digest = name.slice(0, 64);
    const value = loadArtifact(root, "reports", digest) as any;
    if (
      value.status === "reviewed" &&
      value.projectId === projectId &&
      value.mrIid === mrIid &&
      value.headSha === headSha &&
      value.policyHash === policyHash
    )
      return { hash: digest, value };
  }
  return null;
}
