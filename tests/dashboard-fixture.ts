export function card(id = 1, kind = "ask") {
  return {
    id,
    version: 1,
    kind,
    state: "open",
    title: "是否发布",
    text: "完整报告 <script>alert(1)</script>",
    options: kind === "ask" ? ["发布", "不发布"] : ["已处理"],
    recommend: kind === "ask" ? 0 : null,
    choice: null,
    answer: null,
    by: null,
    result: null,
    rule: null,
    createdAt: "2026-11-13T02:00:00.000Z",
    decidedAt: null,
    closedAt: null,
    ref: null,
    link: null,
  };
}
export function state() {
  return {
    now: "2026-11-13T02:00:00.000Z",
    timezone: "Asia/Shanghai",
    totals: { running: 2, doneToday: 3 },
    cards: [card()],
    recentCards: [],
    lines: [],
    elsewhere: [],
  };
}
