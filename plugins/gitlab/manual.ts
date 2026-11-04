export function manualTarget(url: string, origin: string, path: string): number {
  const parsed = new URL(url);
  if (
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(path)
  )
    throw new Error("MR 地址不属于配置项目");
  const prefix = `/${path}/-/merge_requests/`;
  if (!parsed.pathname.startsWith(prefix)) throw new Error("MR 地址不属于配置项目");
  const number = parsed.pathname.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(number) || !Number.isSafeInteger(Number(number))) throw new Error("MR 编号无效");
  return Number(number);
}
export function manualOverrides(record: any, requestId: string, reviewerId: number): ("reviewer" | "draft" | "ci")[] {
  if (
    !record ||
    record.schema !== 1 ||
    record.origin !== "manual" ||
    record.requestId !== requestId ||
    record.reviewerId !== reviewerId ||
    typeof record.reason !== "string" ||
    !record.reason.trim() ||
    !Array.isArray(record.overrides) ||
    record.overrides.some((v: unknown) => !["reviewer", "draft", "ci"].includes(v as string))
  )
    return [];
  return record.overrides;
}
