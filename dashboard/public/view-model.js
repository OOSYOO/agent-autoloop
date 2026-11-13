/** @typedef {import('../src/types.ts').State} State */
/** @typedef {import('../src/types.ts').Card} Card */

/** @param {unknown} value @returns {value is Record<string, any>} */
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value */
const count = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
/** @param {unknown} value */
const date = (value) =>
  typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
/** @param {unknown} value */
const nullableText = (value) => value === null || typeof value === "string";
/** @param {unknown} value @returns {value is Card} */
function validCard(value) {
  if (!object(value) || !count(value.id) || value.id === 0 || !Number.isSafeInteger(value.version)) return false;
  if (!["kind", "state", "title", "text"].every((key) => typeof value[key] === "string")) return false;
  if (!Array.isArray(value.options) || !value.options.every((option) => typeof option === "string")) return false;
  if (
    !["recommend", "choice"].every(
      (key) => value[key] === null || (count(value[key]) && value[key] < value.options.length),
    )
  )
    return false;
  if (!["answer", "by", "result", "rule", "ref", "link"].every((key) => nullableText(value[key]))) return false;
  return date(value.createdAt) && ["decidedAt", "closedAt"].every((key) => value[key] === null || date(value[key]));
}
/** @param {unknown} value @returns {State} */
export function validateState(value) {
  if (!object(value) || !date(value.now) || typeof value.timezone !== "string") throw new Error("中台状态格式不正确");
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: value.timezone });
  } catch {
    throw new Error("中台时区不正确");
  }
  if (!object(value.totals) || !count(value.totals.running) || !count(value.totals.doneToday))
    throw new Error("中台计数不完整");
  if (
    !Array.isArray(value.cards) ||
    !value.cards.every(validCard) ||
    !Array.isArray(value.recentCards) ||
    !value.recentCards.every(validCard)
  )
    throw new Error("中台卡片格式不正确");
  if (
    !Array.isArray(value.lines) ||
    !value.lines.every(
      (line) =>
        object(line) &&
        typeof line.id === "string" &&
        typeof line.name === "string" &&
        nullableText(line.every) &&
        (line.next === null || date(line.next)) &&
        object(line.totals) &&
        ["running", "queued", "retrying", "unknown"].every((key) => count(line.totals[key])),
    )
  )
    throw new Error("中台定时任务格式不正确");
  if (
    !Array.isArray(value.elsewhere) ||
    !value.elsewhere.every(
      (line) =>
        object(line) &&
        ["id", "name", "every", "where"].every((key) => typeof line[key] === "string") &&
        date(line.next),
    )
  )
    throw new Error("外部任务格式不正确");
  return /** @type {State} */ (value);
}
/** @param {string | null} value @param {string} timezone */
export function time(value, timezone) {
  return value === null
    ? "未安排"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        dateStyle: "medium",
        timeStyle: "medium",
        hour12: false,
      }).format(new Date(value));
}
/** @param {string | null} value */
export function safeLink(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
/** @param {State} state */
export function buildOverviewModel(state) {
  const cards = state.cards
    .filter((card) => card.state === "open")
    .map((card) => {
      const paragraph = card.text.trim().split(/\r?\n\s*\r?\n/, 1)[0];
      const chars = [...paragraph];
      return { ...card, preview: chars.length > 300 ? chars.slice(0, 300).join("") + "…" : paragraph };
    });
  return {
    cards,
    waiting: cards.length,
    running: state.totals.running,
    doneToday: state.totals.doneToday,
    timezone: state.timezone,
    scheduled: [
      ...state.lines
        .filter((line) => line.every !== null || line.next !== null)
        .map((line) => {
          const { running, queued, retrying, unknown } = line.totals;
          const status =
            [
              running ? `正在执行 ${running}` : "",
              queued ? `排队 ${queued}${retrying ? `（含重派 ${retrying}）` : ""}` : "",
              unknown ? `执行结果不确定 ${unknown}` : "",
            ]
              .filter(Boolean)
              .join(" · ") || "等待下次计划";
          return {
            key: `中台:${line.id}`,
            name: line.name,
            every: line.every || "未记录周期",
            next: time(line.next, state.timezone),
            status,
          };
        }),
      ...state.elsewhere.map((line) => ({
        key: `外部:${line.id}`,
        name: line.name,
        every: line.every,
        next: time(line.next, state.timezone),
        status: `状态未知 · 在${line.where}执行`,
      })),
    ],
  };
}
