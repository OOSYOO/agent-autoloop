import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "../../protocol/job.ts";
import type { Config } from "./config.ts";
import { loadConfig, policyHash } from "./config.ts";
import { publishDecision } from "./answer.ts";
import { loadArtifact } from "./artifacts.ts";
import { atomicFile, canonical, hash } from "./storage.ts";
import { GitLab } from "./api.ts";
import { readRequests } from "./request.ts";
import { trustedRules, verifyProjectRemote } from "./trusted-rules.ts";
import { manualOverrides } from "./manual.ts";
import { eligible } from "./poll.ts";
import { positionFor } from "./diff.ts";
import { requiresComparison } from "./auto.ts";
import { publishOne } from "./publish.ts";
import { HOME, RULES_FILE } from "../../host/home.ts";
import { loadInstructions, checkJobRule } from "./instructions.ts";
import { nativeBasis } from "./native.ts";

export async function resumeAnswer(
  config: Config,
  answer: Job["context"]["answers"][number],
  configFile?: string,
  contextFile?: string,
): Promise<string> {
  let about: any;
  try {
    about = JSON.parse(answer.about);
  } catch {
    return "ignored";
  }
  const manifestHash = about?.manifestHash;
  if (typeof manifestHash !== "string") return "ignored";
  const choice = publishDecision(answer, manifestHash);
  if (choice === null) return "ignored";
  return publishManifest(config, manifestHash, answer, choice, configFile, contextFile);
}

export async function resumeSaved(config: Config, manifestHash: string, configFile?: string): Promise<string> {
  const file = join(config.dataRoot, "gitlab", "decisions", `${manifestHash}.json`);
  if (!/^[a-f0-9]{64}$/.test(manifestHash) || !existsSync(file)) return "none";
  return publishManifest(config, manifestHash, null, 0, configFile);
}

export async function resumeAutomatic(config: Config, manifestHash: string, configFile?: string): Promise<string> {
  return publishManifest(config, manifestHash, null, 0, configFile);
}

async function publishManifest(
  config: Config,
  manifestHash: string,
  answer: Job["context"]["answers"][number] | null,
  choice: 0 | 1,
  configFile?: string,
  contextFile?: string,
): Promise<string> {
  const root = join(config.dataRoot, "gitlab");
  const man = loadArtifact(root, "manifests", manifestHash) as any;
  const report = loadArtifact(root, "reports", man.reportHash) as any;
  if (
    !man ||
    !Array.isArray(man.items) ||
    !report ||
    report.status !== "reviewed" ||
    man.headSha !== report.headSha ||
    man.policyHash !== report.policyHash
  )
    throw new Error("报告与确认内容不一致");
  const project = config.projects.find((p) => p.id === report.projectId);
  if (!project || !Number.isSafeInteger(report.mrIid) || report.mrIid <= 0) throw new Error("报告项目无效");
  const decisionPath = join(root, "decisions", `${manifestHash}.json`);
  const saved = existsSync(decisionPath);
  if (saved) {
    const old = JSON.parse(readFileSync(decisionPath, "utf8"));
    if (old.schema !== 1 || old.manifestHash !== manifestHash || (old.choice !== 0 && old.choice !== 1))
      throw new Error("确认决定无效");
    if (answer && old.choice !== choice) throw new Error("确认决定冲突");
    if (old.choice === 1) return "rejected";
  }
  if (choice === 1 && answer) {
    if (!saved)
      atomicFile(
        decisionPath,
        JSON.stringify({ schema: 1, manifestHash, cardId: answer.card, choice, by: answer.by, at: answer.at }),
        true,
      );
    return "rejected";
  }
  if (typeof report.instructionsDigest !== "string") return "stale";
  if (!configFile) throw new Error("缺少可信配置路径");
  const instructions = loadInstructions(configFile, project.id, HOME, RULES_FILE);
  if (report.instructions?.prompt !== instructions.prompt || report.model !== config.model) return "stale";
  if (contextFile) checkJobRule(contextFile, instructions);
  const gl = new GitLab(config.glabPath, config.instanceUrl);
  await verifyProjectRemote(gl, project);
  const trusted = trustedRules(project);
  const native = await nativeBasis(config.codexPath, trusted.worktree, instructions.prompt);
  const instructionsDigest = hash(canonical({ prompt: instructions.prompt, native: native.digest }));
  if (
    report.instructionsDigest !== instructionsDigest ||
    report.model !== config.model ||
    policyHash(config, project, instructionsDigest, trusted.digest) !== man.policyHash
  )
    return "stale";
  if (!saved && answer)
    atomicFile(
      decisionPath,
      JSON.stringify({ schema: 1, manifestHash, cardId: answer.card, choice, by: answer.by, at: answer.at }),
      true,
    );
  else if (
    !saved &&
    project.publication !== "auto" &&
    !(project.publication === "severity" && man.mode === "severity-auto")
  )
    throw new Error("未获发布授权");
  if (project.publication === "severity" && !["severity-auto", "severity-manual"].includes(man.mode)) return "stale";
  if (project.publication === "severity" && man.mode === "severity-auto" && answer)
    throw new Error("自动发布清单不能由人工批准");
  const user = (await gl.get("user")) as any;
  if (user?.id !== config.reviewerId) throw new Error("GitLab 登录身份与配置不符");
  const path = `projects/${project.id}/merge_requests/${report.mrIid}`;
  if (
    !answer &&
    !saved &&
    project.publication !== "severity" &&
    requiresComparison(await gl.list(`${path}/discussions?per_page=100`), config.reviewerId, report.headSha)
  )
    return "comparison";
  const request = readRequests(root, project.id, report.mrIid).find((record) => record.requestId === report.requestId);
  if (!request || request.headSha !== report.headSha || request.policyHash !== report.policyHash)
    throw new Error("原审查请求记录缺失或不一致");
  const overrides = manualOverrides(request, report.requestId, config.reviewerId);
  const current = async () => {
    const latest = configFile ? loadConfig(configFile) : config;
    const currentProject = latest.projects.find((item) => item.id === project.id);
    if (!currentProject) return false;
    const currentGl = new GitLab(latest.glabPath, latest.instanceUrl);
    await verifyProjectRemote(currentGl, currentProject);
    const currentInstructions = loadInstructions(configFile, currentProject.id, HOME, RULES_FILE);
    const currentMain = trustedRules(currentProject);
    const currentNative = await nativeBasis(latest.codexPath, currentMain.worktree, currentInstructions.prompt);
    const currentInstructionsDigest = hash(
      canonical({ prompt: currentInstructions.prompt, native: currentNative.digest }),
    );
    if (
      currentInstructionsDigest !== instructionsDigest ||
      policyHash(latest, currentProject, currentInstructionsDigest, currentMain.digest) !== man.policyHash
    )
      return false;
    const mr = (await gl.get(path)) as any;
    return (
      eligible(mr, config.reviewerId, project.ciMode, overrides) &&
      mr.sha === report.headSha &&
      mr.diff_refs?.head_sha === report.headSha &&
      mr.diff_refs?.base_sha === report.baseSha &&
      mr.diff_refs?.start_sha === report.startSha
    );
  };
  if (!(await current()))
    return man.items.some(
      (item: any) =>
        typeof item.actionKey === "string" &&
        /^[a-f0-9]{64}$/.test(item.actionKey) &&
        (() => {
          const file = join(root, "actions", item.actionKey, "sent.json");
          if (!existsSync(file)) return false;
          const saved = JSON.parse(readFileSync(file, "utf8"));
          return !saved.verifiedAt;
        })(),
    )
      ? "sent-stale"
      : "stale";
  const versions = await gl.list(`${path}/versions?per_page=100`);
  const matches = versions.filter(
    (v: any) =>
      v.head_commit_sha === report.headSha &&
      v.base_commit_sha === report.baseSha &&
      v.start_commit_sha === report.startSha,
  ) as any[];
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id)) throw new Error("无法确认 Diff 版本");
  const version = (await gl.get(`${path}/versions/${matches[0].id}`)) as any;
  if (
    version.head_commit_sha !== report.headSha ||
    version.base_commit_sha !== report.baseSha ||
    version.start_commit_sha !== report.startSha ||
    !Array.isArray(version.diffs) ||
    version.diffs.some((d: any) => d.collapsed || d.too_large || typeof d.diff !== "string")
  )
    throw new Error("Diff 不完整");
  const refs = { base_sha: report.baseSha, start_sha: report.startSha, head_sha: report.headSha };
  for (const item of man.items) {
    if (
      !item ||
      typeof item.body !== "string" ||
      (item.position === null && project.publication !== "severity") ||
      typeof item.actionKey !== "string"
    )
      throw new Error("待发布内容无效");
    const p = item.position;
    if (p === null) {
      if (
        hash(canonical([config.instanceKey, project.id, report.mrIid, report.headSha, item.body, null])) !==
        item.actionKey
      )
        throw new Error("评论内容已变化");
      continue;
    }
    if (!p || typeof p !== "object") throw new Error("评论位置无效");
    const side = p.new_line !== undefined ? "new" : "old",
      line = side === "new" ? p.new_line : p.old_line,
      path = side === "new" ? p.new_path : p.old_path;
    const position = positionFor(version.diffs, refs, path, side, line);
    if (
      !position ||
      canonical(position) !== canonical(p) ||
      hash(canonical([config.instanceKey, project.id, report.mrIid, report.headSha, item.body, p])) !== item.actionKey
    )
      throw new Error("评论位置或内容已变化");
  }
  for (const item of man.items) {
    const body = `${item.body}\n\n由 agent-autoloop 生成。\n<!-- agent-autoloop:action=${item.actionKey} -->`;
    const result = await publishOne(root, manifestHash, item, {
      current,
      find: async () => {
        const discussions = await gl.list(`${path}/discussions?per_page=100`);
        for (const discussion of discussions as any[])
          for (const note of discussion.notes ?? []) {
            if (
              note.author?.id !== config.reviewerId ||
              note.body !== body ||
              (item.position === null ? note.position != null : !note.position)
            )
              continue;
            const position =
              item.position === null
                ? null
                : Object.fromEntries(Object.keys(item.position).map((key) => [key, note.position[key]]));
            if (
              canonical(position) === canonical(item.position) &&
              typeof discussion.id === "string" &&
              Number.isSafeInteger(note.id)
            )
              return { discussionId: discussion.id, noteId: note.id, position };
          }
        return null;
      },
      post: async () => {
        const result = (await gl.post(
          `${path}/discussions`,
          item.position === null ? { body } : { body, position: item.position },
        )) as any;
        const note = result?.notes?.[0];
        const position =
          item.position === null
            ? note?.position == null
              ? null
              : note.position
            : note?.position && Object.fromEntries(Object.keys(item.position).map((key) => [key, note.position[key]]));
        return { discussionId: result?.id, noteId: note?.id, position };
      },
    });
    if (result !== "sent") return result;
  }
  return "sent";
}
