import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonical, hash, atomicFile } from "./storage.ts";
type Observation = {
  instanceKey: string;
  projectId: number;
  mrIid: number;
  headSha: string;
  policyHash: string;
  eligible: boolean;
};
type Record = Observation & { schema: 1; observation: number; requestId: string };
export function nextObservation(previous: Record | undefined, value: Observation): Record {
  if (
    !/^[a-z][a-z0-9-]{0,15}$/.test(value.instanceKey) ||
    !Number.isSafeInteger(value.projectId) ||
    value.projectId <= 0 ||
    !Number.isSafeInteger(value.mrIid) ||
    value.mrIid <= 0 ||
    !/^[a-f0-9]{40}$/.test(value.headSha) ||
    !/^[a-f0-9]{64}$/.test(value.policyHash) ||
    typeof value.eligible !== "boolean"
  )
    throw new Error("观察无效");
  if (
    previous &&
    previous.instanceKey === value.instanceKey &&
    previous.projectId === value.projectId &&
    previous.mrIid === value.mrIid &&
    previous.headSha === value.headSha &&
    previous.policyHash === value.policyHash &&
    previous.eligible === value.eligible
  )
    return previous;
  const observation = (previous?.observation ?? 0) + 1;
  if (!Number.isSafeInteger(observation)) throw new Error("观察序号无效");
  return { schema: 1, ...value, observation, requestId: hash(canonical({ ...value, observation })) };
}

type StoredRequest = Record & { origin?: "auto" | "manual"; overrides?: unknown; [key: string]: unknown };
export function saveRequest(root: string, record: StoredRequest): void {
  if (
    record.schema !== 1 ||
    !Number.isSafeInteger(record.projectId) ||
    record.projectId <= 0 ||
    !Number.isSafeInteger(record.mrIid) ||
    record.mrIid <= 0 ||
    !/^[a-f0-9]{64}$/.test(record.requestId)
  )
    throw new Error("请求记录无效");
  const directory = join(root, "requests", `${record.projectId}`);
  const history = join(directory, `${record.mrIid}`, `${record.requestId}.json`);
  if (existsSync(history)) {
    const old = JSON.parse(readFileSync(history, "utf8"));
    const identity = (value: any) => {
      const { delivered, unrouted, ...rest } = value;
      return rest;
    };
    if (
      canonical(identity(old)) !== canonical(identity(record)) ||
      (old.delivered === true && record.delivered !== true) ||
      (old.unrouted === true && record.unrouted !== true)
    )
      throw new Error("请求记录不可改写");
  }
  atomicFile(history, JSON.stringify(record));
  atomicFile(join(directory, `${record.mrIid}.json`), JSON.stringify(record));
}
export function readRequests(root: string, projectId: number, mrIid: number): StoredRequest[] {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(mrIid) || mrIid <= 0)
    throw new Error("请求编号无效");
  const directory = join(root, "requests", `${projectId}`),
    history = join(directory, `${mrIid}`);
  let names: string[] = [];
  try {
    names = readdirSync(history);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const values = new Map<string, StoredRequest>();
  const load = (file: string) => {
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (
      record.schema !== 1 ||
      record.projectId !== projectId ||
      record.mrIid !== mrIid ||
      typeof record.requestId !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.requestId) ||
      ![undefined, "auto", "manual"].includes(record.origin)
    )
      throw new Error("请求记录无效");
    if (!values.has(record.requestId)) values.set(record.requestId, record);
  };
  for (const name of names) {
    if (name.startsWith(".tmp-")) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("请求记录文件无效");
    load(join(history, name));
  }
  const latest = join(directory, `${mrIid}.json`);
  if (existsSync(latest)) load(latest);
  return [...values.values()];
}
export function latestRequest(root: string, projectId: number, mrIid: number): StoredRequest | undefined {
  const records = readRequests(root, projectId, mrIid).sort((a, b) => b.observation - a.observation);
  if (
    records.length > 1 &&
    records[0].observation === records[1].observation &&
    records[0].requestId !== records[1].requestId
  )
    throw new Error("请求观察序号冲突");
  return records[0];
}
