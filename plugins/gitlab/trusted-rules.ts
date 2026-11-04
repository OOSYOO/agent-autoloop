import { execFileSync } from "node:child_process";
import { prepareWorktree, reviewWorktreePath } from "./worktree.ts";
import { canonical, hash } from "./storage.ts";

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_CONFIG_")) delete env[name];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
  };
}

type Settings = { cachePath: string; rulesBranch?: string };
export function validateRulesSettings(project: Settings): { branch: string } {
  const branch = project.rulesBranch ?? "main";
  if (branch !== "main") throw new Error("可信分支无效");
  try {
    execFileSync("git", ["check-ref-format", `refs/heads/${branch}`], { stdio: "ignore" });
  } catch {
    throw new Error("可信分支名无效");
  }
  return { branch };
}

export function effectiveOrigin(cachePath: string): string {
  try {
    return execFileSync("git", ["--git-dir", cachePath, "remote", "get-url", "origin"], {
      env: gitEnvironment(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("无法读取裸缓存远端");
  }
}

export async function verifyProjectRemote(
  gl: { get(path: string): Promise<unknown> },
  project: { id: number; projectPath?: string; cachePath: string },
): Promise<{ path_with_namespace: string }> {
  if (!project.projectPath) throw new Error("请配置项目路径");
  const metadata = (await gl.get(`projects/${project.id}`)) as {
    id?: number;
    path_with_namespace?: string;
    ssh_url_to_repo?: string;
    http_url_to_repo?: string;
  };
  if (metadata?.id !== project.id || metadata.path_with_namespace !== project.projectPath)
    throw new Error("项目身份与 GitLab 不一致");
  const remote = effectiveOrigin(project.cachePath);
  if (!remote || ![metadata.ssh_url_to_repo, metadata.http_url_to_repo].includes(remote))
    throw new Error("裸缓存远端与 GitLab 项目不一致");
  return { path_with_namespace: metadata.path_with_namespace };
}

export function trustedRules(project: Settings) {
  const { branch } = validateRulesSettings(project);
  const worktree = reviewWorktreePath(project.cachePath);
  const commit = prepareWorktree(project.cachePath, branch, worktree);
  return { branch, worktree, commit, digest: hash(canonical({ branch, commit })) };
}
