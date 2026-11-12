import { eligible } from "./ci.ts";
import { nextObservation } from "./request.ts";
type Config = { instanceKey: string; instanceUrl: string; reviewerId: number };
type Project = Pick<import("./config.ts").Project, "id" | "ciMode">;
type Record = ReturnType<typeof nextObservation> & {
  delivered?: boolean;
  unrouted?: boolean;
  origin?: "auto" | "manual";
  overrides?: unknown;
};
type IO = {
  retryUnrouted?: boolean;
  eligible?: (mr: any) => Promise<boolean>;
  list: () => Promise<any[]>;
  read: (iid: number) => Record | undefined;
  write: (record: Record) => void;
  post: (event: object) => Promise<{ event: number; duplicate: boolean; routed: string[] }>;
};
export async function scanProject(
  config: Config,
  project: Project,
  path: string,
  policyHash: string,
  io: IO,
): Promise<void> {
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(path)) throw new Error("项目路径无效");
  const mrs = await io.list();
  for (const mr of mrs) {
    if (!Number.isSafeInteger(mr.iid) || mr.iid <= 0) throw new Error("MR 编号无效");
    const before = io.read(mr.iid);
    if (
      before?.delivered === true &&
      !before.unrouted &&
      before.instanceKey === config.instanceKey &&
      before.projectId === project.id &&
      before.mrIid === mr.iid &&
      before.headSha === mr.sha
    )
      continue;
    const value = {
      instanceKey: config.instanceKey,
      projectId: project.id,
      mrIid: mr.iid,
      headSha: mr.sha,
      policyHash,
      eligible: io.eligible ? await io.eligible(mr) : eligible(mr, config.reviewerId, project.ciMode, []),
    };
    const pendingSameHead =
      before?.origin === "auto" &&
      before.eligible &&
      !before.delivered &&
      !before.unrouted &&
      before.instanceKey === value.instanceKey &&
      before.projectId === value.projectId &&
      before.mrIid === value.mrIid &&
      before.headSha === value.headSha;
    if (pendingSameHead && !value.eligible) continue;
    let next = pendingSameHead ? before : nextObservation(before, value);
    if (
      (before?.origin === "manual" && before.requestId === next.requestId) ||
      (before?.unrouted && io.retryUnrouted && before.requestId === next.requestId)
    )
      next = nextObservation({ ...before, eligible: !before.eligible }, value);
    const same = before?.requestId === next.requestId;
    if (same && before?.unrouted) throw new Error("项目规则未路由，需修复后重新投递");
    if (same && before?.delivered) continue;
    const record: Record = { ...next, origin: "auto" };
    io.write(record);
    if (!value.eligible) continue;
    const detail = {
      schema: 1,
      requestId: next.requestId,
      projectId: project.id,
      mrIid: mr.iid,
      headSha: mr.sha,
      policyHash: next.policyHash,
      observation: next.observation,
      origin: "auto",
    };
    const event = {
      id: `gitlab:${next.requestId}`,
      type: `mr.review.${project.id}`,
      subject: `${config.instanceKey}/${project.id}/${mr.iid}`,
      summary: "审查 MR 当前版本",
      detail: JSON.stringify(detail),
      link: `${config.instanceUrl}/${path}/-/merge_requests/${mr.iid}`,
    };
    const result = await io.post(event);
    if (!Number.isSafeInteger(result.event) || typeof result.duplicate !== "boolean" || !Array.isArray(result.routed))
      throw new Error("中台回执无效");
    if (result.routed.length !== 1) {
      io.write({ ...record, unrouted: true });
      throw new Error("项目规则未路由");
    }
    io.write({ ...record, delivered: true });
  }
}
