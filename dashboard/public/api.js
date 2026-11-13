import { validateState } from "./view-model.js";
export class ApiError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
/** @param {{fetchImpl?: typeof fetch}} options */
export function createApi({ fetchImpl = fetch } = {}) {
  /** @param {string} path @param {RequestInit} options @param {number} timeout */
  async function request(path, options, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetchImpl(path, { ...options, signal: controller.signal });
      const value = await res.json();
      if (!res.ok)
        throw new ApiError(
          typeof value?.code === "string" ? value.code : "UPSTREAM_UNAVAILABLE",
          typeof value?.error === "string" ? value.error : "请求失败",
        );
      return { value, instance: res.headers.get("x-dashboard-instance") };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async state() {
      const { value, instance } = await request("/api/state", { method: "GET" }, 15000);
      if (!instance) throw new ApiError("UPSTREAM_UNAVAILABLE", "缺少看板进程标识");
      return { state: validateState(value), instance };
    },
    /** @param {number} id @param {number} choice @param {string} instance */
    async answer(id, choice, instance) {
      try {
        const { value } = await request(
          `/api/cards/${id}/answer`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-dashboard-action": "answer",
              "x-dashboard-instance": instance,
            },
            body: JSON.stringify({ choice }),
          },
          15000,
        );
        if (
          typeof value?.changed !== "boolean" ||
          !["open", "decided", "done", "closed"].includes(value.state) ||
          (value.changed && !["decided", "closed"].includes(value.state))
        )
          throw new Error("invalid response");
        return /** @type {import('../src/types.ts').Answer} */ (value);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError("OUTCOME_UNKNOWN", "结果待核实，恢复连接后将只读核对，不会自动再次提交");
      }
    },
  };
}
