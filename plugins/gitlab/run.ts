import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, policyHash } from "./config.ts";
import { GitLab, TemporaryError } from "./api.ts";
import { hash, canonical } from "./storage.ts";
import { completedReport, loadArtifact, saveArtifact } from "./artifacts.ts";
import { selectRequest, obsoleteCards, eventMatches, type Request } from "./review.ts";
import { eligibleForReview, isTerminalMR } from "./ci.ts";
import { runCodex } from "./codex.ts";
import { parseModelReport } from "./report.ts";
import { manifest, severityManifests } from "./manifest.ts";
import { readRequests } from "./request.ts";
import { trustedRules, verifyProjectRemote } from "./trusted-rules.ts";
import { manualOverrides } from "./manual.ts";
import { findingsPages, reviewSummary } from "./presentation.ts";
import { answerOutcome } from "./outcome.ts";
import { jobInstructions } from "./instructions.ts";
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
  const instructions = jobInstructions(process.env.AGENT_AUTOLOOP_CONTEXT!);
  const gl = new GitLab(config.glabPath, config.instanceUrl);
  await verifyProjectRemote(gl, project);
  const user = (await gl.get("user")) as { id: number };
  if (user?.id !== config.reviewerId) throw new Error("GitLab 登录身份与配置不符");
  const mr = (await gl.get(`projects/${project.id}/merge_requests/${first.mrIid}`)) as any;
  if (isTerminalMR(mr)) {
    summary = "没事可做：MR 已合并或关闭";
    return;
  }
  resolves.push(
    ...obsoleteCards(context.open ?? [], project.id, first.mrIid, mr.sha, (hash) => {
      const man = loadArtifact(join(config.dataRoot, "gitlab"), "manifests", hash) as { reportHash: string };
      return loadArtifact(join(config.dataRoot, "gitlab"), "reports", man.reportHash) as {
        projectId: number;
        mrIid: number;
        headSha: string;
      };
    }),
  );
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
  const selected = selectRequest(events, local, mr.sha, project.id, first.mrIid);
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
  const reviewContext = {
    projectPath: project.projectPath!,
    mrIid: selected.mrIid,
    title: typeof mr.title === "string" ? mr.title : "",
  };
  const root = join(config.dataRoot, "gitlab");
  const cached = completedReport(root, project.id, selected.mrIid, selected.headSha);
  let report: any, modelReport, audit: string | undefined;
  if (cached) {
    report = cached.value;
    if (
      (report.instanceUrl !== undefined && report.instanceUrl !== config.instanceUrl) ||
      (report.projectPath !== undefined && report.projectPath !== project.projectPath)
    )
      throw new Error("报告项目身份不一致");
    modelReport = parseModelReport(
      JSON.stringify({
        complete: report.complete,
        executionIssue: report.executionIssue,
        findings: report.findings,
      }),
    );
  } else {
    const trusted = trustedRules(project);
    const native = await nativeBasis(config.codexPath, trusted.worktree, instructions.prompt);
    const instructionsDigest = hash(canonical({ prompt: instructions.prompt, native: native.digest }));
    const policy = policyHash(config, project, instructionsDigest, trusted.digest);
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
      instanceUrl: config.instanceUrl,
      projectPath: project.projectPath,
      mrIid: selected.mrIid,
      headSha: selected.headSha,
      policyHash: policy,
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
  if (Buffer.byteLength(canonical(report), "utf8") > 1024 * 1024) throw new Error("完整报告超过大小限制");
  const reportHash = saveArtifact(root, "reports", report);
  const latestConfig = loadConfig(args[1]);
  const latestProject = latestConfig.projects.find((item) => item.id === project.id);
  if (
    !latestProject ||
    latestConfig.instanceKey !== config.instanceKey ||
    latestConfig.instanceUrl !== config.instanceUrl ||
    latestProject.projectPath !== project.projectPath
  )
    throw new Error("审查项目身份已经变化");
  await verifyProjectRemote(new GitLab(latestConfig.glabPath, latestConfig.instanceUrl), latestProject);
  const latestMr = (await new GitLab(latestConfig.glabPath, latestConfig.instanceUrl).get(
    `projects/${project.id}/merge_requests/${selected.mrIid}`,
  )) as any;
  if (isTerminalMR(latestMr)) {
    summary = "没事可做：MR 已合并或关闭，保留审查报告";
    return;
  }
  if (latestMr.sha !== selected.headSha) {
    summary = "没事可做：MR 版本已变化";
    return;
  }
  if (
    !(await eligibleForReview(
      new GitLab(latestConfig.glabPath, latestConfig.instanceUrl),
      latestProject,
      latestMr,
      latestConfig.reviewerId,
      selected.origin === "manual" ? manualOverrides(stored, selected.requestId, latestConfig.reviewerId) : [],
    ))
  )
    throw new Error("MR 状态或发布权限已变化，保留报告等待重试");
  const reportPolicy = report.policyHash as string;
  const originalRequest = records.find((record) => record.requestId === report.requestId);
  if (!originalRequest) throw new Error("原审查请求记录缺失");
  const hasOverrides = (record: typeof originalRequest) =>
    Array.isArray(record.overrides) && record.overrides.length > 0;
  const requestBinding =
    report.requestId !== selected.requestId && (hasOverrides(originalRequest) || (stored && hasOverrides(stored)))
      ? { requestId: selected.requestId }
      : {};

  if (latestProject.publication === "severity") {
    const split = severityManifests(
      config.instanceKey,
      project.id,
      selected.mrIid,
      reportHash,
      reportPolicy,
      refs,
      modelReport.findings,
    );
    if (split.automatic.items.length) {
      const autoHash = saveArtifact(root, "manifests", { ...split.automatic, ...requestBinding });
      const outcome = await resumeAutomatic(latestConfig, autoHash, args[1]);
      if (outcome !== "sent") {
        if (outcome === "stale") {
          summary = "没事可做：MR 状态或发布权限已变化";
          return;
        }
        throw new Error(outcome === "unknown" ? "评论发送结果不明，请本人在 GitLab 核查" : "自动发布未完成");
      }
    }
    const visible = modelReport.findings.filter((finding) => finding.severity === "P2" || finding.severity === "P3");
    if (!modelReport.findings.length || visible.length) {
      const pages = findingsPages(mrUrl, visible, split.manual.items, reviewContext);
      if (split.manual.items.length) {
        const manualHash = saveArtifact(root, "manifests", { ...split.manual, ...requestBinding });
        const saved = await resumeSaved(latestConfig, manualHash, args[1]);
        if (saved === "unknown" || saved === "sent-stale") throw new Error("评论状态未确认，请本人在 GitLab 核查");
        if (saved === "stale") {
          summary = "没事可做：MR 状态或发布权限已变化";
          return;
        }
        if (saved === "none") {
          if (pages.length > 1)
            pages.forEach((text, index) =>
              notices.push({
                key: `findings:${reportHash}:${index}`,
                title: modelReport.findings.length
                  ? `审查结果 ${index + 1}/${pages.length}`
                  : "未发现问题，仍需人工审核",
                text,
              }),
            );
          ask(
            `publish:${manualHash}`,
            `待确认：发布 ${split.manual.items.length} 条审查评论`,
            pages.length === 1
              ? pages[0]
              : reviewSummary(mrUrl, visible, split.manual.items.length, reviewContext) +
                  `\n完整报告共 ${pages.length} 页，见配套通知。`,
            { schema: 1, kind: "publish", manifestHash: manualHash },
            [`发布 ${split.manual.items.length} 条评论`, "不发布"],
          );
        }
      } else
        pages.forEach((text, index) =>
          notices.push({
            key: `findings:${reportHash}:${index}`,
            title: modelReport.findings.length ? `审查结果 ${index + 1}/${pages.length}` : "未发现问题，仍需人工审核",
            text,
          }),
        );
    }
    summary = modelReport.findings.length ? "审查完成" : "未发现问题，仍需人工审核";
    return;
  }
  const value = {
    ...manifest(config.instanceKey, project.id, selected.mrIid, reportHash, reportPolicy, refs, modelReport.findings),
    ...requestBinding,
  };
  const pages = findingsPages(mrUrl, modelReport.findings, value.items, reviewContext);
  if (!value.items.length) {
    pages.forEach((text, index) =>
      notices.push({
        key: `findings:${reportHash}:${index}`,
        title: modelReport.findings.length ? `审查结果 ${index + 1}/${pages.length}` : "未发现问题，仍需人工审核",
        text,
      }),
    );
    summary = modelReport.findings.length ? "审查完成" : "未发现问题，仍需人工审核";
    return;
  }
  const manifestHash = saveArtifact(root, "manifests", value);
  if (canonical(loadArtifact(root, "manifests", manifestHash)) !== canonical(value))
    throw new Error("待发布内容校验失败");
  const savedOutcome = await resumeSaved(latestConfig, manifestHash, args[1]);
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
  if (savedOutcome === "sent-stale") throw new Error("评论已发出，MR 状态或发布权限已变化，请本人处理");
  if (savedOutcome === "stale") {
    summary = "没事可做：MR 状态或发布权限已变化";
    return;
  }
  if (latestProject.publication === "auto") {
    const outcome = await resumeAutomatic(latestConfig, manifestHash, args[1]);
    if (outcome === "sent") {
      summary = "审查评论已发布";
      return;
    }
    if (outcome === "rejected") {
      summary = "已按原决定不发布";
      return;
    }
    if (outcome === "unknown") throw new Error("评论发送结果不明，请本人在 GitLab 核查");
    if (outcome === "sent-stale") throw new Error("评论已发出，MR 状态或发布权限已变化，请本人处理");
    if (outcome === "stale") {
      summary = "没事可做：MR 状态或发布权限已变化";
      return;
    }
    if (outcome !== "comparison") throw new Error("自动发布未完成");
  }
  if (pages.length > 1)
    pages.forEach((text, index) =>
      notices.push({
        key: `findings:${reportHash}:${index}`,
        title: modelReport.findings.length ? `审查结果 ${index + 1}/${pages.length}` : "未发现问题，仍需人工审核",
        text,
      }),
    );
  ask(
    `publish:${manifestHash}`,
    `待确认：发布 ${value.items.length} 条审查评论`,
    pages.length === 1
      ? pages[0]
      : reviewSummary(mrUrl, modelReport.findings, value.items.length, reviewContext) +
          `\n完整报告共 ${pages.length} 页，见配套通知。`,
    { schema: 1, kind: "publish", manifestHash },
    [`发布 ${value.items.length} 条评论`, "不发布"],
  );
}
main()
  .catch((error) => {
    console.error(error instanceof TemporaryError ? "GitLab 暂时不可用" : (error as Error).message);
    process.exitCode = 1;
  })
  .finally(emit);
