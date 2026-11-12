import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "../../protocol/job.ts";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { publishDecision } from "./answer.ts";
import { loadArtifact } from "./artifacts.ts";
import { atomicFile, canonical, hash } from "./storage.ts";
import { GitLab } from "./api.ts";
import { readRequests } from "./request.ts";
import { verifyProjectRemote } from "./trusted-rules.ts";
import { manualOverrides } from "./manual.ts";
import { eligibleForReview } from "./ci.ts";
import { requiresComparison } from "./auto.ts";
import { publishOne } from "./publish.ts";
import { severityItemsMatch } from "./manifest.ts";
import { parseModelReport } from "./report.ts";

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
  if (
    answer &&
    /^发布 [1-9]\d* 条评论$/.test(answer.options[0]) &&
    answer.options[0] !== `发布 ${man.items.length} 条评论`
  )
    throw new Error("确认数量与发布清单不一致");
  const project = config.projects.find((p) => p.id === report.projectId);
  if (!project || !Number.isSafeInteger(report.mrIid) || report.mrIid <= 0) throw new Error("报告项目无效");
  if (
    (report.instanceUrl !== undefined && report.instanceUrl !== config.instanceUrl) ||
    (report.projectPath !== undefined && report.projectPath !== project.projectPath)
  )
    return "stale";
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
  if (project.publication === "severity") {
    const findings = parseModelReport(
      JSON.stringify({ complete: report.complete, executionIssue: report.executionIssue, findings: report.findings }),
    ).findings;
    const mode = man.mode === "severity-auto" ? "auto" : "manual";
    if (
      ![undefined, "severity-auto", "severity-manual"].includes(man.mode) ||
      !severityItemsMatch(
        config.instanceKey,
        project.id,
        report.mrIid,
        man.reportHash,
        man.policyHash,
        { head_sha: report.headSha },
        findings,
        man.items,
        mode,
      )
    )
      return "stale";
  }
  if (!configFile) throw new Error("缺少可信配置路径");
  const gl = new GitLab(config.glabPath, config.instanceUrl);
  await verifyProjectRemote(gl, project);
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
  if (
    project.publication === "severity" &&
    !["severity-auto", "severity-manual"].includes(man.mode) &&
    !answer &&
    !saved
  )
    return "stale";
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
  const requestId = man.requestId ?? report.requestId;
  const request = readRequests(root, project.id, report.mrIid).find((record) => record.requestId === requestId);
  if (!request || request.instanceKey !== config.instanceKey || request.headSha !== report.headSha)
    throw new Error("原审查请求记录缺失或不一致");
  const current = async () => {
    const latest = configFile ? loadConfig(configFile) : config;
    const currentProject = latest.projects.find((item) => item.id === project.id);
    if (
      !currentProject ||
      latest.instanceKey !== config.instanceKey ||
      latest.instanceUrl !== config.instanceUrl ||
      currentProject.projectPath !== project.projectPath
    )
      return false;
    const currentGl = new GitLab(latest.glabPath, latest.instanceUrl);
    await verifyProjectRemote(currentGl, currentProject);
    const currentUser = (await currentGl.get("user")) as { id?: number };
    if (currentUser?.id !== latest.reviewerId) return false;
    if (
      !answer &&
      !saved &&
      !(
        currentProject.publication === "auto" ||
        (currentProject.publication === "severity" && man.mode === "severity-auto")
      )
    )
      return false;
    if (currentProject.publication === "severity") {
      const findings = parseModelReport(
        JSON.stringify({ complete: report.complete, executionIssue: report.executionIssue, findings: report.findings }),
      ).findings;
      const mode = man.mode === "severity-auto" ? "auto" : "manual";
      if (
        !severityItemsMatch(
          latest.instanceKey,
          currentProject.id,
          report.mrIid,
          man.reportHash,
          man.policyHash,
          { head_sha: report.headSha },
          findings,
          man.items,
          mode,
        )
      )
        return false;
    }
    const mr = (await currentGl.get(path)) as any;
    return (
      (await eligibleForReview(
        currentGl,
        currentProject,
        mr,
        latest.reviewerId,
        manualOverrides(request, requestId, latest.reviewerId),
      )) && mr.sha === report.headSha
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
  for (const item of man.items) {
    if (!item || typeof item.body !== "string" || typeof item.actionKey !== "string") throw new Error("待发布内容无效");
    if (item.position !== null) return "stale";
    if (
      hash(canonical([config.instanceKey, project.id, report.mrIid, report.headSha, item.body, null])) !==
      item.actionKey
    )
      throw new Error("评论内容已变化");
  }
  for (const item of man.items) {
    const body = `${item.body}\n\n由 agent-autoloop 生成。\n<!-- agent-autoloop:action=${item.actionKey} -->`;
    const result = await publishOne(root, manifestHash, item, {
      current,
      find: async () => {
        const discussions = await gl.list(`${path}/discussions?per_page=100`);
        for (const discussion of discussions as any[])
          for (const note of discussion.notes ?? []) {
            if (note.author?.id !== config.reviewerId || note.body !== body || note.position != null) continue;
            if (typeof discussion.id === "string" && Number.isSafeInteger(note.id))
              return { discussionId: discussion.id, noteId: note.id, position: null };
          }
        return null;
      },
      post: async () => {
        const result = (await gl.post(`${path}/discussions`, { body })) as any;
        const note = result?.notes?.[0];
        return { discussionId: result?.id, noteId: note?.id, position: note?.position ?? null };
      },
    });
    if (result !== "sent") return result;
  }
  return "sent";
}
