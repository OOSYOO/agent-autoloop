import { validateState } from "../public/view-model.js";
import type { Answer } from "./types.ts";
export class HubError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function createHubClient({
  hubUrl,
  owner,
  timeoutMs = 5000,
  fetchImpl = fetch,
}: {
  hubUrl: URL;
  owner: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}) {
  const active = new Set<AbortController>();
  let closed = false;
  async function request(path: string, body?: { choice: number }) {
    const controller = new AbortController();
    if (closed) controller.abort();
    active.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(new URL(path, hubUrl), {
        method: body ? "POST" : "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${owner}`,
          accept: "application/json",
          ...(body && { "content-type": "application/json" }),
        },
        ...(body && { body: JSON.stringify(body) }),
      });
      if (res.status === 401 || res.status === 403)
        throw new HubError(401, "UPSTREAM_AUTH_FAILED", "中台鉴权失败，请检查配置");
      if (body && [400, 404, 409].includes(res.status))
        throw new HubError(409, "CARD_UNAVAILABLE", "此卡片已不在待处理列表，请刷新核对");
      if (!res.ok || !res.headers.get("content-type")?.includes("application/json"))
        throw new Error("invalid response");
      const value = await res.json();
      if (!body) return validateState(value);
      if (
        !value ||
        typeof value.changed !== "boolean" ||
        !["open", "decided", "done", "closed"].includes(value.state) ||
        (value.changed && !["decided", "closed"].includes(value.state))
      )
        throw new Error("invalid answer");
      return value as Answer;
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new HubError(
        controller.signal.aborted ? 504 : 502,
        body ? "OUTCOME_UNKNOWN" : controller.signal.aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        body
          ? "结果待核实，请刷新核对，不会自动再次提交"
          : controller.signal.aborted
            ? "中台读取超时，尚未发送决定"
            : "无法读取中台状态，尚未发送决定",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
      active.delete(controller);
    }
  }
  const state = async () => (await request("/v1/state")) as ReturnType<typeof validateState>;
  return {
    state,
    async answer(id: number, choice: number) {
      const snapshot = await state();
      const card = snapshot.cards.find((card) => card.id === id && card.state === "open");
      if (!card) throw new HubError(409, "CARD_UNAVAILABLE", "此卡片已不在待处理列表，请刷新核对");
      if (
        !["ask", "notice"].includes(card.kind) ||
        choice >= card.options.length ||
        (card.kind === "notice" && choice !== 0)
      )
        throw new HubError(400, "INVALID_CHOICE", "请选择卡片原有选项");
      return (await request(`/v1/cards/${id}/answer`, { choice })) as Answer;
    },
    close() {
      closed = true;
      for (const controller of active) controller.abort();
    },
  };
}
