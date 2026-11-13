import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function reviewWorktreePath(cachePath: string): string {
  return join(dirname(cachePath), `${basename(cachePath)}.codereview-worktree`);
}

export function prepareWorktree(cachePath: string, branch = "main", path = reviewWorktreePath(cachePath)): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_CONFIG_") && !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].includes(key)) delete env[key];
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_SHALLOW_FILE",
    "GIT_REPLACE_REF_BASE",
  ])
    delete env[key];
  const bare = realpathSync(cachePath);
  const git = (...args: string[]) =>
    execFileSync("git", ["--git-dir", bare, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (git("rev-parse", "--is-bare-repository") !== "true") throw new Error("审查缓存不是裸仓库");
  try {
    git("check-ref-format", `refs/heads/${branch}`);
  } catch {
    throw new Error("可信分支无效");
  }
  try {
    if (git("config", "--local", "--get-regexp", "^filter\\.")) throw new Error("审查缓存包含过滤器配置");
  } catch (error) {
    if ((error as Error).message === "审查缓存包含过滤器配置") throw error;
    if ((error as { status?: number }).status !== 1) throw error;
  }
  const marker = join(bare, "agent-autoloop-worktree.json");
  if (existsSync(path)) {
    if (!existsSync(marker)) throw new Error("审查目录不属于本安装");
    const owner = JSON.parse(readFileSync(marker, "utf8"));
    if (owner.schema !== 1 || owner.path !== path || owner.cache !== bare) throw new Error("审查目录归属不匹配");
    const common = execFileSync("git", ["-C", path, "rev-parse", "--git-common-dir"], { env, encoding: "utf8" }).trim();
    if (realpathSync(resolve(path, common)) !== bare) throw new Error("审查工作树来源不匹配");
  } else if (existsSync(marker)) throw new Error("专用审查目录缺失，需检查归属");
  const ref = "refs/agent-autoloop/review-main";
  git(
    "fetch",
    "--no-recurse-submodules",
    "--no-tags",
    "--no-write-fetch-head",
    "origin",
    `+refs/heads/${branch}:${ref}`,
  );
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("可信分支提交无效");
  if (!existsSync(path)) {
    git("worktree", "add", "--detach", "--no-checkout", path, commit);
    writeFileSync(marker, JSON.stringify({ schema: 1, path, cache: bare }), { mode: 0o600, flag: "wx" });
  }
  execFileSync(
    "git",
    ["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "reset", "--hard", commit],
    { env, stdio: "ignore" },
  );
  execFileSync("git", ["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "clean", "-fd"], {
    env,
    stdio: "ignore",
  });
  return commit;
}
