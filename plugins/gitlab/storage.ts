import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("无法规范化数据");
  return result;
}
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function syncDir(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function atomicFile(path: string, text: string, immutable = false): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.tmp-${randomUUID()}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (immutable) {
      linkSync(temp, path);
      unlinkSync(temp);
    } else renameSync(temp, path);
    syncDir(dir);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {}
    throw error;
  }
}
export function claimAction(root: string, actionKey: string, manifestHash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actionKey) || !/^[a-f0-9]{64}$/.test(manifestHash)) throw new Error("无效摘要");
  const parent = join(root, "actions");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = join(parent, actionKey);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  syncDir(parent);
  atomicFile(
    join(dir, "intent.json"),
    JSON.stringify({ schema: 1, manifestHash, actionKey, createdAt: new Date().toISOString() }),
    true,
  );
  return true;
}
