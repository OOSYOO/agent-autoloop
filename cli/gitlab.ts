import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { HOME, RULES_FILE } from "../host/home.ts";
import { loadInstructions } from "../plugins/gitlab/instructions.ts";
import { effectiveOrigin, validateRulesSettings } from "../plugins/gitlab/trusted-rules.ts";
import { loadConfig } from "../plugins/gitlab/config.ts";
import { reviewWorktreePath } from "../plugins/gitlab/worktree.ts";

export function checkGitlab(file: string, home = HOME, rulesFile = RULES_FILE) {
  const config = loadConfig(file);
  const key = statSync(config.sourceKeyPath);
  if (!key.isFile() || (key.mode & 0o077) !== 0 || !readFileSync(config.sourceKeyPath, "utf8").trim())
    throw new Error("来源密钥必须是非空私有文件，权限请设为 0600");
  for (const program of [config.codexPath, config.glabPath]) accessSync(program, constants.X_OK);
  const projects = config.projects.map((project) => {
    if (!project.projectPath) throw new Error(`项目 ${project.id} 缺少项目路径`);
    validateRulesSettings(project);
    const instructions = loadInstructions(file, project.id, home, rulesFile);
    const git = (...args: string[]) =>
      execFileSync("git", ["--git-dir", project.cachePath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    if (git("rev-parse", "--is-bare-repository") !== "true") throw new Error(`项目 ${project.id} 需要独立裸 Git 缓存`);
    const remote = effectiveOrigin(project.cachePath);
    if (!remote) throw new Error(`项目 ${project.id} 缺少 origin`);
    let displayRemote = remote;
    try {
      const url = new URL(remote);
      url.username = "";
      url.password = "";
      displayRemote = url.toString();
    } catch {}
    return {
      ...project,
      remote: displayRemote,
      reviewWorktree: reviewWorktreePath(project.cachePath),
      instructions: {
        rule: instructions.ruleName,

        digest: instructions.digest,
      },
    };
  });
  return {
    config: resolve(file),
    instance: config.instanceUrl,
    model: config.model,
    effort: config.effort,
    dataRoot: config.dataRoot,
    projects,
  };
}

export function gitlab(args: string[]) {
  const [action, ...options] = args;
  if (!action || action === "help") {
    console.log(
      `GitLab 审查\n  agent-autoloop gitlab check [--config gitlab/config.json]\n  agent-autoloop gitlab scan [--config gitlab/config.json] [--mr <链接>]\n\n配置路径相对中台数据目录；配置内路径相对配置文件。扫描会按可信规则提交审查请求。\n模型在配置的 model/effort；扫描周期在 rules.json 的 when.cron。`,
    );
    return;
  }
  if (!["check", "scan"].includes(action)) throw new Error("GitLab 子命令只支持 check 或 scan");
  const index = options.indexOf("--config");
  if (index >= 0 && (!options[index + 1] || options[index + 1].startsWith("--"))) throw new Error("缺少配置路径");
  const file = resolve(HOME, index < 0 ? "gitlab/config.json" : options[index + 1]);
  if (index >= 0) options.splice(index, 2);
  if (action === "check") {
    if (options.length) throw new Error("check 只接受 --config");
    console.log(JSON.stringify(checkGitlab(file), null, 2));
    console.log("本地配置检查通过；未连接 GitLab，未验证原生 Skill/运行安全配置，未启动审查或发送消息。");
    return;
  }
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../plugins/gitlab/poll.ts"), "--config", file, ...options],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`扫描未完成（退出码 ${result.status ?? result.signal}）`);
}
