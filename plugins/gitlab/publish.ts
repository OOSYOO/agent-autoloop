import { existsSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { atomicFile, claimAction, canonical } from "./storage.ts";
import { GitLabWriteError } from "./api.ts";
type Item = { actionKey: string; body: string; position: { head_sha: string } };
type Remote = { discussionId: string; noteId: number; position: unknown };
type IO = {
  current: () => Promise<boolean>;
  find: (item: Item) => Promise<Remote | null>;
  post: (item: Item) => Promise<Remote>;
};
function valid(result: Remote, item: Item): boolean {
  return (
    typeof result.discussionId === "string" &&
    !!result.discussionId &&
    Number.isSafeInteger(result.noteId) &&
    result.noteId > 0 &&
    !!result.position &&
    canonical(result.position) === canonical(item.position)
  );
}
export async function publishOne(
  root: string,
  manifestHash: string,
  item: Item,
  io: IO,
): Promise<"sent" | "unknown" | "stale" | "sent-stale"> {
  const dir = join(root, "actions", item.actionKey),
    sent = join(dir, "sent.json");
  if (existsSync(sent)) {
    const value = JSON.parse(readFileSync(sent, "utf8"));
    if (value.schema !== 1 || !valid(value, item)) throw new Error("发送记录无效");
    if (value.verifiedAt) return "sent";
    if (!(await io.current())) return "sent-stale";
    atomicFile(sent, JSON.stringify({ ...value, verifiedAt: new Date().toISOString() }));
    return "sent";
  }
  if (!(await io.current())) return "stale";
  const existing = await io.find(item);
  const claimed = claimAction(root, item.actionKey, manifestHash);
  if (existing) {
    if (!valid(existing, item)) throw new Error("远端记录无效");
    const record = { schema: 1, ...existing, sentAt: new Date().toISOString() };
    atomicFile(sent, JSON.stringify(record));
    if (!(await io.current())) return "sent-stale";
    atomicFile(sent, JSON.stringify({ ...record, verifiedAt: new Date().toISOString() }));
    return "sent";
  }
  if (!claimed) {
    const found = await io.find(item);
    if (!found) return "unknown";
    if (!valid(found, item)) throw new Error("远端记录无效");
    const record = { schema: 1, ...found, sentAt: new Date().toISOString() };
    atomicFile(sent, JSON.stringify(record));
    if (!(await io.current())) return "sent-stale";
    atomicFile(sent, JSON.stringify({ ...record, verifiedAt: new Date().toISOString() }));
    return "sent";
  }
  let current: boolean;
  try {
    current = await io.current();
  } catch (error) {
    releaseUnsent();
    throw error;
  }
  if (!current) {
    releaseUnsent();
    return "stale";
  }
  function releaseUnsent() {
    unlinkSync(join(dir, "intent.json"));
    try {
      rmdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
  }
  let result: Remote;
  try {
    result = await io.post(item);
  } catch (error) {
    const status = error instanceof GitLabWriteError ? error.status : null;
    atomicFile(
      join(dir, "post-failure.json"),
      JSON.stringify({
        schema: 1,
        kind: status === null ? "transport_or_unknown" : "http_response",
        status,
        at: new Date().toISOString(),
      }),
    );
    return "unknown";
  }
  if (!valid(result, item)) {
    atomicFile(
      join(dir, "post-failure.json"),
      JSON.stringify({ schema: 1, kind: "invalid_response", status: 201, at: new Date().toISOString() }),
    );
    return "unknown";
  }
  const record = { schema: 1, ...result, sentAt: new Date().toISOString() };
  atomicFile(sent, JSON.stringify(record));
  if (!(await io.current())) return "sent-stale";
  atomicFile(sent, JSON.stringify({ ...record, verifiedAt: new Date().toISOString() }));
  return "sent";
}
