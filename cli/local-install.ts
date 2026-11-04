import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const entries = ["bin", "cli", "host", "kernel", "protocol", "worker", "plugins", "skills", "package.json"];
const kind = "agent-autoloop-local-install";
const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;
export function localWrapper(home: string): string {
  const root = resolve(home);
  return `#!/bin/sh\n# agent-autoloop managed wrapper v1\nAGENT_AUTOLOOP_HOME=${quote(root)}\nexport AGENT_AUTOLOOP_HOME\nexec node --disable-warning=ExperimentalWarning ${quote(join(root, "app", "bin", "agent-autoloop.ts"))} "$@"\n`;
}
export function isManagedLocalInstall(root: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(root, "local-install.json"), "utf8"));
    return value.schema === 1 && value.kind === kind;
  } catch {
    return false;
  }
}
export function isManagedLocalWrapper(home: string): boolean {
  const file = join(home, "bin", "agent-autoloop");
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) return false;
  try {
    return readFileSync(file, "utf8") === localWrapper(home);
  } catch {
    return false;
  }
}
function sourceIdentity(source: string): { sourceCommit: string | null; sourceDirty: boolean | null } {
  if (!existsSync(join(source, ".git"))) return { sourceCommit: null, sourceDirty: null };
  try {
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const commit = run("rev-parse", "--verify", "HEAD");
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("invalid commit");
    const changed = run("status", "--porcelain", "--untracked-files=all", "--", ...entries);
    const ignored = run(
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
      "--",
      ...entries,
    )
      .split("\0")
      .some((file) => file && !file.split("/").some((part) => part === ".git" || part === "node_modules"));
    return { sourceCommit: commit, sourceDirty: !!changed || ignored };
  } catch {
    throw new Error("无法读取源码提交状态");
  }
}
function contentHash(root: string): string {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        rel = prefix ? `${prefix}/${name}` : name,
        stat = lstatSync(path);
      if (stat.isDirectory()) walk(path, rel);
      else if (stat.isFile()) files.push(rel);
      else throw new Error("安装内容包含不支持的文件类型");
    }
  };
  for (const entry of entries) {
    const path = join(root, entry),
      stat = lstatSync(path);
    if (stat.isDirectory()) walk(path, entry);
    else if (stat.isFile()) files.push(entry);
    else throw new Error("安装内容包含不支持的文件类型");
  }
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    const data = readFileSync(join(root, file)),
      mode = lstatSync(join(root, file)).mode & 0o777;
    digest.update(`${Buffer.byteLength(file)}:${file}:${mode}:${data.length}:`);
    digest.update(data);
  }
  return digest.digest("hex");
}
/** Copies runtime files to an owned install, preserving the previous install if replacement fails. */
export function installLocal(sourceRoot: string, home: string): string {
  const source = realpathSync(resolve(sourceRoot));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const targetHome = resolve(home),
    physicalDestination = join(realpathSync(targetHome), "app"),
    destination = join(targetHome, "app"),
    bin = join(targetHome, "bin"),
    wrapper = join(bin, "agent-autoloop");
  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || !isManagedLocalInstall(destination)))
    throw new Error("安装目录不是受管理的本地安装");
  if (existing && realpathSync(destination) === source) throw new Error("源码与安装目录相同");
  const relation = relative(source, physicalDestination);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation)))
    throw new Error("安装目录不能位于源码目录内");
  const reverse = relative(physicalDestination, source);
  if (reverse === "" || (!reverse.startsWith("..") && !isAbsolute(reverse))) throw new Error("源码不能位于安装目录内");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  if (lstatSync(wrapper, { throwIfNoEntry: false }) && !isManagedLocalWrapper(targetHome))
    throw new Error("已有不属于本安装的启动命令");
  const identity = sourceIdentity(source);
  const staging = mkdtempSync(join(targetHome, ".app-stage-"));
  const temporaryWrapper = join(bin, `.agent-autoloop-${randomUUID()}`);
  let backup: string | undefined,
    installed = false;
  try {
    for (const entry of entries)
      cpSync(join(source, entry), join(staging, entry), {
        recursive: true,
        filter: (path) => {
          if ([".git", "node_modules"].includes(basename(path))) return false;
          if (lstatSync(path).isSymbolicLink()) throw new Error("安装内容包含符号链接");
          return true;
        },
      });
    const manifest = {
      schema: 1,
      kind,
      ...identity,
      contentSha256: contentHash(staging),
      installedAt: new Date().toISOString(),
    };
    writeFileSync(join(staging, "local-install.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    writeFileSync(temporaryWrapper, localWrapper(targetHome), { mode: 0o755, flag: "wx" });
    if (existing) {
      backup = mkdtempSync(join(targetHome, ".app-previous-"));
      rmSync(backup, { recursive: true });
      renameSync(destination, backup);
    }
    renameSync(staging, destination);
    installed = true;
    renameSync(temporaryWrapper, wrapper);
    if (backup) {
      try {
        rmSync(backup, { recursive: true, force: true });
      } catch {
        console.warn(`新安装已完成，旧安装未清理：${backup}`);
      }
      backup = undefined;
    }
    return join(destination, "bin", "agent-autoloop.ts");
  } catch (error) {
    if (installed) rmSync(destination, { recursive: true, force: true });
    if (backup) {
      try {
        renameSync(backup, destination);
        backup = undefined;
      } catch {
        throw new Error(`恢复原安装失败，原文件保存在 ${backup}`);
      }
    }
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(temporaryWrapper, { force: true });
  }
}
