import { createApi, ApiError } from "./api.js";
import { buildOverviewModel, safeLink, time } from "./view-model.js";
/** @typedef {import('../src/types.ts').Card} Card */
/** @typedef {{choice:number|null,pending:boolean,message:string,uncertain:boolean,reconciled:boolean}} Action */
/** @param {{document:Document,fetchImpl?:typeof fetch,setTimer?:(fn:()=>void,ms:number)=>any,clearTimer?:(handle:any)=>void,interval?:number}} options */
export function startDashboardApp({
  document,
  fetchImpl = fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  interval = 10000,
}) {
  const api = createApi({ fetchImpl });
  /** @type {import('../src/types.ts').State|null} */ let snapshot = null;
  /** @type {string|null} */ let instance = null;
  /** @type {number|null} */ let opened = null;
  /** @type {Map<number,Action>} */ const actions = new Map();
  const handled = new Set();
  /** @type {Map<number,boolean>} */ const expanded = new Map();
  let generation = 0,
    reloadRequired = false,
    disposed = false;
  /** @type {Promise<void>|null} */ let pendingRead = null;
  /** @type {any} */ let timer = null;
  let lastSuccess = "",
    error = "";
  /** @param {string} id */ const root = (id) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`缺少页面区域 ${id}`);
    return node;
  };
  /** @param {number} id */ function action(id) {
    if (!actions.has(id))
      actions.set(id, { choice: null, pending: false, message: "", uncertain: false, reconciled: false });
    return /** @type {Action} */ (actions.get(id));
  }
  /** @param {string} tag @param {string} [text] @param {string} [className] */
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  /** @param {string} text @param {()=>void} click */
  function button(text, click) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = text;
    node.addEventListener("click", click);
    return node;
  }
  function model() {
    return snapshot
      ? buildOverviewModel({ ...snapshot, cards: snapshot.cards.filter((card) => !handled.has(card.id)) })
      : null;
  }
  function currentCard() {
    return (
      snapshot?.cards.find((card) => card.id === opened) ||
      snapshot?.recentCards.find((card) => card.id === opened) ||
      null
    );
  }
  /** @type {Card|null} */ let detailCard = null;
  function getView() {
    const item = opened === null ? null : action(opened),
      card = currentCard();
    return {
      model: model(),
      selection: item?.choice ?? null,
      message: item?.message || "",
      reloadRequired,
      canSubmit: !!(
        card &&
        card.state === "open" &&
        !handled.has(card.id) &&
        !reloadRequired &&
        !item?.pending &&
        (!item?.uncertain || item.reconciled) &&
        ["ask", "notice"].includes(card.kind) &&
        card.options.length &&
        (card.kind === "notice" || item?.choice !== null)
      ),
    };
  }
  function renderDetail() {
    const focus = document.activeElement?.id;
    const detail = root("detail");
    detail.hidden = opened === null;
    detail.replaceChildren();
    if (opened === null) return;
    const card = currentCard() || detailCard,
      item = action(opened);
    if (!card) return;
    const close = button("关闭详情", () => {
      opened = null;
      renderDetail();
      document.getElementById(`open-card-${card.id}`)?.focus({ preventScroll: true });
    });
    close.id = `close-card-${card.id}`;
    detail.append(
      close,
      el("h2", card.title),
      el(
        "p",
        `${card.rule || (card.kind === "notice" ? "系统通知" : "未关联规则")} · ${time(card.createdAt, snapshot?.timezone || "UTC")}`,
        "meta",
      ),
    );
    const report = document.createElement("details");
    report.open = expanded.get(card.id) ?? card.text.length < 800;
    report.addEventListener("toggle", () => expanded.set(card.id, report.open));
    const disclosure = el("summary", "完整内容");
    disclosure.id = `report-${card.id}`;
    report.append(disclosure, el("pre", card.text, "report"));
    detail.append(report);
    const link = safeLink(card.link);
    if (link) {
      const anchor = document.createElement("a");
      anchor.id = `link-${card.id}`;
      anchor.href = link;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = "查看相关链接";
      detail.append(anchor);
    }
    const controls = document.createElement("fieldset");
    const view = getView();
    controls.disabled =
      item.pending ||
      reloadRequired ||
      handled.has(card.id) ||
      card.state !== "open" ||
      (item.uncertain && !item.reconciled);
    if (card.kind === "ask" && card.options.length) {
      controls.append(el("legend", "选择处理方式"));
      card.options.forEach((option, index) => {
        const label = el("label", undefined, "option"),
          input = document.createElement("input");
        input.type = "radio";
        input.id = `choice-${card.id}-${index}`;
        input.name = `card-${card.id}`;
        input.value = String(index);
        input.checked = item.choice === index;
        input.addEventListener("change", () => choose(index));
        label.append(input, el("span", `${option}${card.recommend === index ? "（建议）" : ""}`));
        controls.append(label);
      });
    } else if (card.kind === "ask") detail.append(el("p", "此问题需要文字回答，请使用原通道或命令行"));
    else if (card.kind !== "notice") detail.append(el("p", "此卡片类型暂不支持，请使用原通道或命令行"));
    if (["ask", "notice"].includes(card.kind) && card.options.length) {
      const submitButton = button(
        item.pending
          ? "正在提交…"
          : card.kind === "notice"
            ? "已处理"
            : item.choice === null
              ? "请先选择处理方式"
              : `确认：${card.options[item.choice]}`,
        () => {
          void submit();
        },
      );
      submitButton.id = `submit-${card.id}`;
      submitButton.disabled = !view.canSubmit;
      submitButton.className = "primary";
      controls.append(submitButton);
    }
    detail.append(controls);
    const message = el("p", reloadRequired ? "看板已重启，请重新加载页面后操作" : item.message, "decision");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    detail.append(message);
    if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
  }
  function render() {
    const focus = document.activeElement?.id;
    const view = getView(),
      m = view.model;
    root("status").textContent = reloadRequired
      ? "看板已重启，请重新加载页面"
      : error
        ? `读取失败：${error}${lastSuccess ? ` · 最后更新 ${lastSuccess}（数据已过期）` : ""}`
        : lastSuccess
          ? `最后更新 ${lastSuccess}`
          : "正在读取…";
    root("status").className = error || reloadRequired ? "status-error" : "status-ok";
    if (m) {
      const summary = root("summary");
      summary.replaceChildren();
      for (const [label, value] of [
        ["待我处理", m.waiting],
        ["正在运行", m.running],
        ["今日完成轮次", m.doneToday],
      ]) {
        const node = el("div", undefined, "stat");
        node.append(el("span", String(value), "stat-value"), el("span", String(label)));
        summary.append(node);
      }
      const waiting = root("waiting");
      waiting.replaceChildren(el("h2", `待我处理 · ${m.waiting}`));
      if (!m.cards.length) waiting.append(el("p", "暂时没有需要你处理的事项", "empty"));
      for (const card of m.cards) {
        const row = el("article", undefined, "entry");
        const openButton = button(card.title, () => open(card.id));
        openButton.id = `open-card-${card.id}`;
        row.append(
          openButton,
          el(
            "span",
            `${card.rule || (card.kind === "notice" ? "系统通知" : "未关联规则")} · ${time(card.createdAt, m.timezone)}`,
            "meta",
          ),
        );
        waiting.append(row);
      }
      const scheduled = root("scheduled");
      scheduled.replaceChildren(el("h2", "定时任务"), el("p", `计划时间 · ${m.timezone}；实际执行可能排队`, "meta"));
      if (!m.scheduled.length) scheduled.append(el("p", "暂无定时任务", "empty"));
      for (const task of m.scheduled) {
        const row = el("article", undefined, "entry");
        row.append(
          el("h3", task.name),
          el("p", `${task.key} · ${task.every}`, "meta"),
          el("p", `下次计划：${task.next}`),
          el("p", task.status, "meta"),
        );
        scheduled.append(row);
      }
    }
    renderDetail();
    if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
  }
  function reconcile() {
    if (!snapshot) return;
    for (const [id, item] of actions) {
      if (!item.uncertain || item.pending) continue;
      const card = snapshot.cards.find((c) => c.id === id && c.state === "open"),
        record = snapshot.recentCards.find((c) => c.id === id);
      item.reconciled = true;
      if (card) {
        item.message = "上次结果未确认，卡片仍开放；如需再次提交，请明确点击确认。";
      } else if (record) {
        item.message = `中台已记录：${record.choice === null ? record.answer || record.state : record.options[record.choice] || record.state} · ${record.by || "未记录回答者"} · ${time(record.decidedAt || record.closedAt, snapshot.timezone)}${record.result ? ` · ${record.result}` : ""}。此记录不证明由本次请求提交。`;
        handled.add(id);
      } else {
        item.message = "已不在待处理列表，提交结果未能核实";
        handled.add(id);
      }
    }
  }
  function refresh() {
    if (disposed) return Promise.resolve();
    if (pendingRead) return pendingRead;
    const readGeneration = generation;
    const promise = (async () => {
      try {
        const result = await api.state();
        if (disposed || readGeneration !== generation) return;
        if (instance && instance !== result.instance) {
          reloadRequired = true;
          render();
          return;
        }
        instance ||= result.instance;
        snapshot = result.state;
        lastSuccess = time(snapshot.now, snapshot.timezone);
        error = "";
        reconcile();
        render();
      } catch (err) {
        if (disposed || readGeneration !== generation) return;
        error = err instanceof Error ? err.message : "连接失败";
        render();
      }
    })().finally(() => {
      if (pendingRead === promise) pendingRead = null;
    });
    pendingRead = promise;
    return promise;
  }
  /** @param {number} id */ function open(id) {
    const card = snapshot?.cards.find((c) => c.id === id);
    if (!card) return;
    opened = id;
    detailCard = card;
    renderDetail();
  }
  /** @param {number} choice */ function choose(choice) {
    if (opened === null) return;
    const item = action(opened),
      card = currentCard();
    if (
      item.pending ||
      reloadRequired ||
      !card ||
      !Number.isSafeInteger(choice) ||
      choice < 0 ||
      choice >= card.options.length
    )
      return;
    item.choice = choice;
    renderDetail();
  }
  async function submit() {
    if (opened === null || !instance || !getView().canSubmit) return;
    const id = opened,
      item = action(id),
      card = currentCard();
    if (!card) return;
    item.pending = true;
    item.message = "正在提交…";
    generation++;
    pendingRead = null;
    renderDetail();
    try {
      const result = await api.answer(id, card.kind === "notice" ? 0 : /** @type {number} */ (item.choice), instance);
      handled.add(id);
      item.uncertain = false;
      item.message = result.changed
        ? card.kind === "notice"
          ? "通知已处理"
          : "决定已提交"
        : "此卡片已被处理，本次未更改";
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "OUTCOME_UNKNOWN";
      if (code === "PAGE_RELOAD_REQUIRED") reloadRequired = true;
      item.uncertain = code === "OUTCOME_UNKNOWN" || code === "CARD_UNAVAILABLE";
      item.reconciled = false;
      item.message = err instanceof Error ? err.message : "结果待核实";
    } finally {
      item.pending = false;
      generation++;
      pendingRead = null;
      render();
      await refresh();
    }
  }
  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (disposed || document.hidden) return;
    timer = setTimer(() => {
      timer = null;
      void refresh();
      schedule();
    }, interval);
  }
  const visibility = () => {
    if (!document.hidden) void refresh();
    schedule();
  };
  document.addEventListener("visibilitychange", visibility);
  root("refresh").addEventListener("click", () => {
    void refresh();
  });
  const ready = refresh();
  schedule();
  return {
    ready,
    refresh,
    open,
    choose,
    submit,
    getView,
    dispose() {
      disposed = true;
      generation++;
      if (timer !== null) clearTimer(timer);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
