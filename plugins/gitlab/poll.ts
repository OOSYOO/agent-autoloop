export function discoveryPath(projectId: number): string {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("项目编号无效");
  return `projects/${projectId}/merge_requests?state=opened&per_page=100`;
}
export { eligible } from "./ci.ts";
import { eligibleForReview, type Override } from "./ci.ts";

async function main() {
  const { readFileSync, existsSync } = await import("node:fs");
  const { HOME, RULES_FILE } = await import("../../host/home.ts");
  const { loadInstructions } = await import("./instructions.ts");
  const { nativeBasis } = await import("./native.ts");
  const { join } = await import("node:path");
  const { loadConfig, policyHash } = await import("./config.ts");
  const { hash, atomicFile, canonical } = await import("./storage.ts");
  const { GitLab, TemporaryError } = await import("./api.ts");
  const { trustedRules, verifyProjectRemote } = await import("./trusted-rules.ts");
  const { scanProject } = await import("./scan.ts");
  const { manualTarget } = await import("./manual.ts");
  const { nextObservation, saveRequest, latestRequest } = await import("./request.ts");
  const argv = process.argv.slice(2);
  if (argv.length < 2 || argv[0] !== "--config") throw new Error("请提供配置文件路径");
  let mrUrl: string | undefined,
    reason = "",
    overrides: Override[] = [],
    retryUnrouted = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--mr" && argv[i + 1]) mrUrl = argv[++i];
    else if (argv[i] === "--reason" && argv[i + 1]) reason = argv[++i];
    else if (argv[i] === "--override" && argv[i + 1]) {
      const parts = argv[++i].split(",");
      if (parts.some((p) => !["reviewer", "draft", "ci"].includes(p)) || new Set(parts).size !== parts.length)
        throw new Error("覆盖项无效");
      overrides = parts as Override[];
    } else if (argv[i] === "--retry-unrouted") retryUnrouted = true;
    else throw new Error("参数无效");
  }
  if ((!mrUrl && (overrides.length || reason)) || (overrides.length && !reason.trim()))
    throw new Error("覆盖条件需要目标和原因");
  const config = loadConfig(argv[1]);
  const gl = new GitLab(config.glabPath, config.instanceUrl);
  const user = (await gl.get("user")) as { id?: number };
  if (user?.id !== config.reviewerId) throw new Error("GitLab 登录身份与配置不符");
  const token = readFileSync(config.sourceKeyPath, "utf8").trim();
  if (!token) throw new Error("来源密钥为空");
  const errors: string[] = [];
  let foundManual = false;
  let temporary = false;
  for (const project of config.projects) {
    try {
      const metadata = await verifyProjectRemote(gl, project);
      const rules = trustedRules(project);
      const instructions = loadInstructions(argv[1], project.id, HOME, RULES_FILE);
      const native = await nativeBasis(config.codexPath, rules.worktree, instructions.prompt);
      const instructionsDigest = hash(canonical({ prompt: instructions.prompt, native: native.digest }));
      if (mrUrl) {
        let iid: number;
        try {
          iid = manualTarget(mrUrl, config.instanceUrl, metadata.path_with_namespace);
        } catch {
          continue;
        }
        foundManual = true;
        const mr = (await gl.get(`projects/${project.id}/merge_requests/${iid}`)) as any;
        if (!(await eligibleForReview(gl, project, mr, config.reviewerId, overrides)))
          throw new Error("MR 未满足审查条件");
        const digest = policyHash(config, project, instructionsDigest, rules.digest);
        const file = join(config.dataRoot, "gitlab", "requests", `${project.id}`, `${iid}.json`);
        const previous = latestRequest(join(config.dataRoot, "gitlab"), project.id, iid);
        const value = {
          instanceKey: config.instanceKey,
          projectId: project.id,
          mrIid: iid,
          headSha: mr.sha,
          policyHash: digest,
          eligible: true,
        };
        let observation = nextObservation(previous, value);
        const sameManual =
          previous?.origin === "manual" &&
          previous.headSha === mr.sha &&
          previous.policyHash === digest &&
          canonical(previous.overrides) === canonical(overrides) &&
          previous.reason === reason &&
          !previous.delivered &&
          !previous.unrouted;
        if (!sameManual && previous && observation.requestId === previous.requestId)
          observation = nextObservation({ ...previous, eligible: false }, value);
        const record = sameManual
          ? previous
          : {
              ...observation,
              origin: "manual" as const,
              reviewerId: config.reviewerId,
              overrides,
              reason,
              requestedAt: new Date().toISOString(),
            };
        saveRequest(join(config.dataRoot, "gitlab"), record);
        const detail = {
          schema: 1,
          requestId: record.requestId,
          projectId: project.id,
          mrIid: iid,
          headSha: mr.sha,
          policyHash: digest,
          observation: record.observation,
          origin: "manual",
        };
        const event = {
          id: `gitlab:${record.requestId}`,
          type: `mr.review.${project.id}`,
          subject: `${config.instanceKey}/${project.id}/${iid}`,
          summary: "审查 MR 当前版本",
          detail: JSON.stringify(detail),
          link: mrUrl,
        };
        const response = await fetch(`${config.hubUrl}/v1/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(event),
        });
        if (response.status >= 500 || response.status === 429) throw new TemporaryError("中台暂时不可用");
        if (!response.ok) throw new Error(`中台接收失败（${response.status}）`);
        const receipt = (await response.json()) as any;
        if (
          !Number.isSafeInteger(receipt.event) ||
          typeof receipt.duplicate !== "boolean" ||
          !Array.isArray(receipt.routed)
        )
          throw new Error("中台回执无效");
        if (receipt.routed.length !== 1) {
          saveRequest(join(config.dataRoot, "gitlab"), { ...record, unrouted: true });
          throw new Error("项目规则未路由");
        }
        saveRequest(join(config.dataRoot, "gitlab"), { ...record, delivered: true });
        continue;
      }
      const entries = await gl.list(discoveryPath(project.id));
      const mrs: any[] = [];
      for (const item of entries) {
        const iid = (item as { iid?: number }).iid;
        if (!Number.isSafeInteger(iid) || (iid as number) <= 0) throw new Error("MR 编号无效");
        mrs.push(await gl.get(`projects/${project.id}/merge_requests/${iid}`));
      }
      const digest = policyHash(config, project, instructionsDigest, rules.digest);
      const directory = join(config.dataRoot, "gitlab", "requests", `${project.id}`);
      await scanProject(config, project, metadata.path_with_namespace, digest, {
        retryUnrouted,
        eligible: (mr) => eligibleForReview(gl, project, mr, config.reviewerId, []),
        list: async () => mrs,
        read: (iid) => latestRequest(join(config.dataRoot, "gitlab"), project.id, iid),
        write: (record) => saveRequest(join(config.dataRoot, "gitlab"), record),
        post: async (event) => {
          const response = await fetch(`${config.hubUrl}/v1/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(event),
          });
          if (response.status >= 500 || response.status === 429) throw new TemporaryError("中台暂时不可用");
          if (!response.ok) throw new Error(`中台接收失败（${response.status}）`);
          return (await response.json()) as { event: number; duplicate: boolean; routed: string[] };
        },
      });
    } catch (error) {
      if (error instanceof TemporaryError || error instanceof TypeError) temporary = true;
      errors.push(`项目 ${project.id}：${(error as Error).message}`);
    }
  }
  if (mrUrl && !foundManual) throw new Error("MR 不属于配置实例或项目");
  if (temporary) throw new TemporaryError("GitLab 或中台暂时不可用");
  if (errors.length) throw new Error(errors.join("；"));
  console.log("扫描完成");
}
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    const { TemporaryError } = await import("./api.ts");
    if (error instanceof TemporaryError) {
      console.log("没跑成：GitLab 或中台暂时不可用");
      return;
    }
    const text = (error as Error).message.slice(0, 1000);
    console.log(
      `待你处理：GitLab 扫描没有完成\n\`\`\`agent-autoloop\n${JSON.stringify({ ask: [{ key: "gitlab:scan", title: "GitLab 扫描需要处理", text, options: ["已处理", "稍后处理"], about: "修复配置或连接后重新扫描" }] })}\n\`\`\``,
    );
  });
}
