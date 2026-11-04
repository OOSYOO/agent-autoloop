import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class MissingObjectError extends Error {}

export function snapshot(bare: string, output: string, base: string, head: string): void {
  if (![base, head].every((value) => /^[a-f0-9]{40}$/.test(value))) throw new Error("Git 对象摘要无效");
  const env = {
    PATH: process.env.PATH,
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["--git-dir", bare, ...args], { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (git("rev-parse", "--is-bare-repository").trim() !== "true") throw new Error("缓存不是裸仓库");
  try {
    git("cat-file", "-e", base);
    git("cat-file", "-e", head);
  } catch {
    throw new MissingObjectError("缓存缺少审查对象");
  }
  const diff = git(
    "-c",
    "core.attributesFile=/dev/null",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    base,
    head,
    "--",
  );
  const entries = git("ls-tree", "-r", "-z", "--full-tree", head).split("\0").filter(Boolean);
  const index: { path: string; file: string; mode: string; encoding: string }[] = [];
  let total = 0;
  mkdirSync(join(output, "files"), { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (
      !match ||
      match[4].includes("\ufffd") ||
      match[2] !== "blob" ||
      !["100644", "100755", "120000"].includes(match[1])
    )
      throw new Error("代码对象无法完整转换为资料");
    const sizeText = git("cat-file", "-s", match[3]).trim();
    const size = Number(sizeText);
    if (!/^(0|[1-9][0-9]*)$/.test(sizeText) || !Number.isSafeInteger(size)) throw new Error("代码对象大小无效");
    if (size > 128 * 1024 * 1024 - total) throw new Error("文字快照过大，无法完整审查");
    total += size;
    const data = execFileSync("git", ["--git-dir", bare, "cat-file", "blob", match[3]], {
      env,
      maxBuffer: size + 1,
    });
    if (data.length !== size) throw new Error("代码对象无法完整转换为资料");
    let contents: string,
      encoding = "utf8";
    try {
      contents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
      if (contents.includes("\0")) throw new Error("binary");
    } catch {
      contents = data.toString("hex");
      encoding = "hex";
    }
    const file = `files/${createHash("sha256").update(match[4]).digest("hex")}.txt`;
    index.push({ path: match[4], file, mode: match[1], encoding });
    writeFileSync(join(output, file), contents, { mode: 0o400, flag: "wx" });
  }
  writeFileSync(join(output, "index.json"), JSON.stringify(index), { mode: 0o400 });
  writeFileSync(join(output, "changes.txt"), diff, { mode: 0o400 });
}

export function fetchObjects(bare: string, mrIid: number): void {
  if (!Number.isSafeInteger(mrIid) || mrIid <= 0) throw new Error("MR 编号无效");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const git = (...args: string[]) =>
    execFileSync("git", ["--git-dir", bare, "-c", "core.hooksPath=/dev/null", ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
  if (git("rev-parse", "--is-bare-repository").trim() !== "true") throw new Error("缓存不是裸仓库");
  git(
    "fetch",
    "--no-recurse-submodules",
    "--no-tags",
    "origin",
    "+refs/heads/*:refs/remotes/origin/*",
    `+refs/merge-requests/${mrIid}/head:refs/agent-autoloop/mr/${mrIid}`,
  );
}
