import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, policyHash } from "./config.ts";
import { GitLab, TemporaryError } from "./api.ts";
import { hash, canonical } from "./storage.ts";
import { completedReport, loadArtifact, saveArtifact } from "./artifacts.ts";
import { selectRequest, obsoleteCards, eventMatches, type Request } from "./review.ts";
import { eligibleForReview } from "./ci.ts";
import { runCodex } from "./codex.ts";
import { parseModelReport } from "./report.ts";
import { manifest, severityManifests } from "./manifest.ts";
import { readRequests } from "./request.ts";
import { trustedRules, verifyProjectRemote } from "./trusted-rules.ts";
import { manualOverrides } from "./manual.ts";
import { findingsPages } from "./presentation.ts";
import { answerOutcome } from "./outcome.ts";
import { HOME, RULES_FILE } from "../../host/home.ts";
import { loadInstructions, checkJobRule } from "./instructions.ts";
import { nativeBasis } from "./native.ts";
import { resumeAnswer, resumeAutomatic, resumeSaved } from "./resume.ts";
import type { Job } from "../../protocol/job.ts";

let summary = "本轮已处理";
let answerSummary: string | null = null;
const asks: { key: string; title: string; text: string; options: string[]; about: string }[] = [];
const resolves: { card: number; reason: string }[] = [];
const notices: { key: string; title: string; text: string }[] = [];
function ask(key: string, title: string, text: string, about: object, options = ["已处理", "稍后处理"]) {
  asks.push({ key, title, text, options, about: JSON.stringify(about) });
}
function emit() {
  const receipt = {
    ...(asks.length ? { ask: asks } : {}),
    ...(resolves.length ? { resolve: resolves } : {}),
    ...(notices.length ? { notice: notices } : {}),
  };
  console.log(
    (answerSummary ?? summary) +
      (asks.length || resolves.length || notices.length
        ? `\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``
        : ""),
  );
}
async function main() {
  const args = process.argv.slice(2);
  if (
    (args.length !== 4 && args.length !== 6) ||
    args[0] !== "--config" ||
    args[2] !== "--model" ||
    (args.length === 6 && args[4] !== "--effort")
  )
    throw new Error("请提供配置和模型");
  const config = loadConfig(args[1]);
  if (args[3] !== config.model || (args[5] || undefined) !== config.effort) throw new Error("模型配置与执行参数不一致");
  const runId = Number(process.env.AGENT_AUTOLOOP_RUN);
  if (!Number.isSafeInteger(runId) || runId <= 0 || !process.env.AGENT_AUTOLOOP_CONTEXT)
    throw new Error("缺少运行上下文");
  const context: Job["context"] = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT, "utf8"));
  if (!Array.isArray(context.events) || !Array.isArray(context.answers)) throw new Error("运行上下文无效");
  const hasEvents = context.events.some((event) => eventMatches(event, config.instanceKey));
  if (context.answers.length) {
    const outcomes: string[] = [];
    for (const answer of context.answers) {
      try {
        outcomes.push(await resumeAnswer(config, answer, args[1], process.env.AGENT_AUTOLOOP_CONTEXT));
      } catch (error) {
        if (!hasEvents) throw error;
        console.error(`先前回答未处理：${(error as Error).message}`);
      }
    }
    answerSummary = answerOutcome(outcomes);
    if (answerSummary && !hasEvents) return;
  }
  const events: { detail: string }[] = context.events.filter((event) => eventMatches(event, config.instanceKey));
  if (!events.length) {
    summary = "没事可做：没有有效的 GitLab 请求";
    return;
  }
  const parsed = events
    .map((e) => {
      try {
        return JSON.parse(e.detail) as Request;
      } catch {
        return null;
      }
    })
    .filter((v): v is Request => !!v);
  if (!parsed.length) throw new Error("请求资料无效");
  const first = parsed[0],
    project = config.projects.find((p) => p.id === first.projectId);
  if (!project || parsed.some((r) => r.projectId !== first.projectId || r.mrIid !== first.mrIid))
    throw new Error("请求项目或事项不一致");
  const instructions = loadInstructions(args[1], project.id, HOME, RULES_FILE);
  checkJobRule(process.env.AGENT_AUTOLOOP_CONTEXT!, instructions);
  const gl = new GitLab(config.glabPath, config.instanceUrl);
  await verifyProjectRemote(gl, project);
  const trusted = trustedRules(project);
  const native = await nativeBasis(config.codexPath, trusted.worktree, instructions.prompt);
  const instructionsDigest = hash(canonical({ prompt: instructions.prompt, native: native.digest }));
  const policy = policyHash(config, project, instructionsDigest, trusted.digest);
  const user = (await gl.get("user")) as { id: number };
  if (user?.id !== config.reviewerId) throw new Error("GitLab 登录身份与配置不符");
  const mr = (await gl.get(`projects/${project.id}/merge_requests/${first.mrIid}`)) as any;
  resolves.push(...obsoleteCards(context.open ?? [], project.id, first.mrIid, mr.sha, policy));
  const records = readRequests(join(config.dataRoot, "gitlab"), project.id, first.mrIid);
  const local: Request[] = records.map((stored) => ({
    schema: 1,
    requestId: stored.requestId,
    projectId: stored.projectId,
    mrIid: stored.mrIid,
    headSha: stored.headSha,
    policyHash: stored.policyHash,
    observation: stored.observation,
    origin: stored.origin === "manual" ? "manual" : "auto",
  }));
  const selected = selectRequest(events, local, mr.sha, policy, project.id, first.mrIid);
  if (!selected) {
    summary = "没事可做：请求版本已过期";
    return;
  }
  const stored = records.find((record) => record.requestId === selected.requestId);
  const overrides = selected.origin === "manual" ? manualOverrides(stored, selected.requestId, config.reviewerId) : [];
  if (!(await eligibleForReview(gl, project, mr, config.reviewerId, overrides)))
    throw new Error("当前 MR 未满足审查条件");
  const refs = { head_sha: selected.headSha };
  const mrUrl = `${config.instanceUrl}/${project.projectPath}/-/merge_requests/${selected.mrIid}`;
  const root = join(config.dataRoot, "gitlab");
  const cached = completedReport(root, project.id, selected.mrIid, selected.headSha, policy);
  let report: any, modelReport, audit: string | undefined;
  if (cached && cached.value.instructionsDigest === instructionsDigest && cached.value.model === config.model) {
    report = cached.value;
    modelReport = parseModelReport(
      JSON.stringify({
        complete: report.complete,
        executionIssue: report.executionIssue,
        findings: report.findings,
      }),
    );
    if (report.requestId !== selected.requestId)
      report = { ...report, requestId: selected.requestId, runId, createdAt: new Date().toISOString() };
  } else {
    const rulesEvidence = { branch: trusted.branch, commit: trusted.commit, digest: trusted.digest };
    const dir = mkdtempSync(join(config.dataRoot, "gitlab-review-"));
    try {
      const result = await runCodex(
        config.codexPath,
        trusted.worktree,
        config.model,
        config.effort,
        `${instructions.prompt}\n\nMR：${mrUrl}\n本轮 MR head：${selected.headSha}`,
        join(config.dataRoot, "gitlab", "diagnostics"),
        dir,
      );
      modelReport = result.report;
      audit = `diagnostics/${result.audit}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    report = {
      schema: 1,
      requestId: selected.requestId,
      projectId: selected.projectId,
      mrIid: selected.mrIid,
      headSha: selected.headSha,
      policyHash: selected.policyHash,
      model: config.model,
      instructionsDigest,
      instructions: {
        prompt: instructions.prompt,
        nativeCatalog: native.skills,
        nativeFiles: native.files,
        nativeDigest: native.digest,
        scope: "只读审查；不执行 MR 代码、测试或 hooks",
      },
      mainSha: trusted.commit,
      trustedRules: rulesEvidence,
      runId,
      status: "reviewed",
      audit,
      ...modelReport,
      createdAt: new Date().toISOString(),
    };
  }
  const latestConfig = loadConfig(args[1]);
  const latestProject = latestConfig.projects.find((item) => item.id === project.id);
  if (!latestProject) throw new Error("审查配置已经变化");
  await verifyProjectRemote(new GitLab(latestConfig.glabPath, latestConfig.instanceUrl), latestProject);
  const latestInstructions = loadInstructions(args[1], latestProject.id, HOME, RULES_FILE);
  const latestMain = trustedRules(latestProject);
  const latestNative = await nativeBasis(latestConfig.codexPath, latestMain.worktree, latestInstructions.prompt);
  const latestInstructionsDigest = hash(canonical({ prompt: latestInstructions.prompt, native: latestNative.digest }));
  if (policyHash(latestConfig, latestProject, latestInstructionsDigest, latestMain.digest) !== policy)
    throw new Error("审查配置已经变化");
  const latestMr = (await new GitLab(latestConfig.glabPath, latestConfig.instanceUrl).get(
    `projects/${project.id}/merge_requests/${selected.mrIid}`,
  )) as any;
  if (
    !(await eligibleForReview(
      new GitLab(latestConfig.glabPath, latestConfig.instanceUrl),
      latestProject,
      latestMr,
      latestConfig.reviewerId,
      overrides,
    )) ||
    latestMr.sha !== selected.headSha
  ) {
    summary = "没事可做：MR 版本或审查条件已变化";
    return;
  }
  if (Buffer.byteLength(canonical(report), "utf8") > 1024 * 1024) throw new Error("完整报告超过大小限制");
  const reportHash = saveArtifact(root, "reports", report);
  if (project.publication === "severity") {
    const split = severityManifests(
      config.instanceKey,
      project.id,
      selected.mrIid,
      reportHash,
      policy,
      refs,
      modelReport.findings,
    );
    if (split.automatic.items.length) {
      const autoHash = saveArtifact(root, "manifests", split.automatic);
      const outcome = await resumeAutomatic(config, autoHash, args[1]);
      if (outcome !== "sent") {
        if (outcome === "stale") {
          summary = "没事可做：版本已变化";
          return;
        }
        throw new Error(outcome === "unknown" ? "评论发送结果不明，请本人在 GitLab 核查" : "自动发布未完成");
      }
    }
    const visible = modelReport.findings.filter((finding) => finding.severity === "P2" || finding.severity === "P3");
    if (!modelReport.findings.length || visible.length) {
      const pages = findingsPages(
        mrUrl,
        selected.headSha,
        reportHash,
        project.id,
        selected.mrIid,
        policy,
        visible,
        split.manual.items,
      );
      if (split.manual.items.length) {
        const manualHash = saveArtifact(root, "manifests", split.manual);
        const saved = await resumeSaved(config, manualHash, args[1]);
        if (saved === "unknown" || saved === "sent-stale") throw new Error("评论状态未确认，请本人在 GitLab 核查");
        if (saved === "stale") {
          summary = "没事可做：版本已变化";
          return;
        }
        if (saved === "none") {
          if (pages.length > 1)
            pages.forEach((text, index) =>
              notices.push({
                key: `findings:${reportHash}:${index}`,
                title: `审查 findings ${index + 1}/${pages.length}`,
                text,
              }),
            );
          ask(
            `publish:${manualHash}`,
            "确认发布审查评论",
            pages.length === 1
              ? pages[0]
              : `MR ${project.id}/${selected.mrIid}，版本 ${selected.headSha}，策略 ${policy}，\nMR：${mrUrl}\n报告：${reportHash}\n全部 findings 共 ${pages.length} 页，见同报告编号的通知；仅发布标记为“将发布”的项目。`,
            { schema: 1, kind: "publish", manifestHash: manualHash },
            ["发布这份报告中的评论", "不发布"],
          );
        }
      } else
        pages.forEach((text, index) =>
          notices.push({
            key: `findings:${reportHash}:${index}`,
            title: `审查 findings ${index + 1}/${pages.length}`,
            text,
          }),
        );
    }
    summary = modelReport.findings.length ? "审查完成" : "0 条 findings，请继续人工 review / 审核";
    return;
  }
  const value = manifest(
    config.instanceKey,
    project.id,
    selected.mrIid,
    reportHash,
    policy,
    refs,
    modelReport.findings,
  );
  const pages = findingsPages(
    mrUrl,
    selected.headSha,
    reportHash,
    project.id,
    selected.mrIid,
    policy,
    modelReport.findings,
    value.items,
  );
  if (!value.items.length) {
    pages.forEach((text, index) =>
      notices.push({
        key: `findings:${reportHash}:${index}`,
        title: `审查 findings ${index + 1}/${pages.length}`,
        text,
      }),
    );
    summary = modelReport.findings.length ? "审查完成" : "0 条 findings";
    return;
  }
  const manifestHash = saveArtifact(root, "manifests", value);
  if (canonical(loadArtifact(root, "manifests", manifestHash)) !== canonical(value))
    throw new Error("待发布内容校验失败");
  const savedOutcome = await resumeSaved(config, manifestHash, args[1]);
  if (savedOutcome === "sent") {
    summary = "审查评论已发布";
    return;
  }
  if (savedOutcome === "rejected") {
    summary = "已按原决定不发布";
    return;
  }
  if (savedOutcome === "unknown") {
    if (answerSummary) return;
    throw new Error("评论发送结果不明，请本人在 GitLab 核查");
  }
  if (savedOutcome === "sent-stale") throw new Error("评论已发到旧版本，请本人处理");
  if (savedOutcome === "stale") {
    summary = "没事可做：版本已变化";
    return;
  }
  if (project.publication === "auto") {
    const outcome = await resumeAutomatic(config, manifestHash, args[1]);
    if (outcome === "sent") {
      summary = "审查评论已发布";
      return;
    }
    if (outcome === "rejected") {
      summary = "已按原决定不发布";
      return;
    }
    if (outcome === "unknown") throw new Error("评论发送结果不明，请本人在 GitLab 核查");
    if (outcome === "sent-stale") throw new Error("评论已发到旧版本，请本人处理");
    if (outcome === "stale") {
      summary = "没事可做：版本已变化";
      return;
    }
    if (outcome !== "comparison") throw new Error("自动发布未完成");
  }
  if (pages.length > 1)
    pages.forEach((text, index) =>
      notices.push({
        key: `findings:${reportHash}:${index}`,
        title: `审查 findings ${index + 1}/${pages.length}`,
        text,
      }),
    );
  ask(
    `publish:${manifestHash}`,
    "确认发布审查评论",
    pages.length === 1
      ? pages[0]
      : `MR ${project.id}/${selected.mrIid}，版本 ${selected.headSha}，策略 ${policy}，\nMR：${mrUrl}\n版本：${selected.headSha}\n报告：${reportHash}\n全部 findings 共 ${pages.length} 页，见同报告编号的通知；仅发布标记为“将发布”的项目。`,
    { schema: 1, kind: "publish", manifestHash },
    ["发布这份报告中的评论", "不发布"],
  );
}
main()
  .catch((error) => {
    console.error(error instanceof TemporaryError ? "GitLab 暂时不可用" : (error as Error).message);
    process.exitCode = 1;
  })
  .finally(emit);
