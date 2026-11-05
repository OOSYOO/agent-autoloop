import { execFileSync } from "node:child_process";

/** Codex reads exact Git objects from the existing cache; preparing them never checks out MR code. */
export function prepareObjects(bare: string, mrIid: number, shas: string[]): void {
  if (!Number.isSafeInteger(mrIid) || mrIid <= 0) throw new Error("MR 编号无效");
  if (!shas.length || !shas.every((sha) => /^[a-f0-9]{40}$/.test(sha))) throw new Error("Git 对象摘要无效");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const git = (...args: string[]) =>
    execFileSync("git", ["--git-dir", bare, "-c", "core.hooksPath=/dev/null", ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (git("rev-parse", "--is-bare-repository") !== "true") throw new Error("缓存不是裸仓库");
  const check = () => {
    for (const sha of shas) git("cat-file", "-e", sha);
  };
  try {
    check();
  } catch {
    git(
      "fetch",
      "--no-recurse-submodules",
      "--no-tags",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
      `+refs/merge-requests/${mrIid}/head:refs/agent-autoloop/mr/${mrIid}`,
    );
    check();
  }
}
