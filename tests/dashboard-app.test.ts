// Failure modes: recommended approvals are preselected, stale reads reopen answered cards,
// failures erase choices, or uncertain writes are retried without a fresh explicit decision.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startDashboardApp } from "../dashboard/public/app-controller.js";
import { state, card } from "./dashboard-fixture.ts";
function documentFixture() {
  const listeners: Record<string, Function> = {};
  let activeElement: any = null;
  const contains = (parent: any, target: any): boolean =>
    parent === target || parent.children.some((child: any) => contains(child, target));
  const node = (tag = "div"): any => ({
    tagName: tag,
    listeners: {} as Record<string, Function>,
    children: [],
    textContent: "",
    hidden: false,
    append(...items: any[]) {
      this.children.push(...items);
    },
    replaceChildren(...items: any[]) {
      if (contains(this, activeElement)) activeElement = null;
      this.children = items;
    },
    setAttribute() {},
    addEventListener(name: string, fn: Function) {
      this.listeners[name] = fn;
    },
    dispatch(name: string) {
      this.listeners[name]?.();
    },
    focus() {
      activeElement = this;
    },
  });
  const nodes = Object.fromEntries(
    ["summary", "waiting", "scheduled", "detail", "status", "refresh"].map((id) => [id, node()]),
  );
  return {
    hidden: false,
    createElement: node,
    get activeElement() {
      return activeElement;
    },
    getElementById: (id: string) => {
      const find = (parent: any): any => (parent.id === id ? parent : parent.children.map(find).find(Boolean));
      return nodes[id] || Object.values(nodes).map(find).find(Boolean);
    },
    addEventListener: (name: string, fn: Function) => (listeners[name] = fn),
    removeEventListener() {},
    dispatch: (name: string) => listeners[name]?.(),
    nodes,
  };
}
function response(value: unknown, status = 200, instance = "instance") {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "x-dashboard-instance": instance, "content-type": "application/json" },
  });
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
function app(fetchImpl: typeof fetch) {
  const document = documentFixture();
  const app = startDashboardApp({ document: document as any, fetchImpl, setTimer: () => 0, clearTimer: () => {} });
  return { app, document };
}

test("explicit original options, no preselection, duplicate suppression and success surviving failed refresh", async () => {
  let posts = 0,
    fail = false;
  let release: (r: Response) => void = () => {};
  const f = app(async (_url, options) => {
    if (options?.method === "POST") {
      posts++;
      return new Promise((r) => (release = r));
    }
    if (fail) throw new Error("offline");
    return response(state());
  });
  await f.app.ready;
  f.app.open(1);
  assert.equal(f.app.getView().selection, null);
  await f.app.submit();
  assert.equal(posts, 0);
  f.app.choose(1);
  const pending = f.app.submit();
  const duplicate = f.app.submit();
  await flush();
  assert.equal(posts, 1);
  fail = true;
  release(response({ changed: true, state: "decided" }));
  await Promise.all([pending, duplicate]);
  assert.match(f.app.getView().message, /决定已提交/);
  assert.equal(f.app.getView().model?.waiting, 0);
  assert.match(f.document.nodes.status.textContent, /最后更新/);
});

test("late reads are discarded and a fresh read follows writes", async () => {
  let reads = 0;
  let release: (r: Response) => void = () => {};
  const f = app(async (_url, options) => {
    if (options?.method === "POST") return response({ changed: true, state: "decided" });
    reads++;
    if (reads === 2) return new Promise((r) => (release = r));
    return response(reads > 2 ? { ...state(), cards: [] } : state());
  });
  await f.app.ready;
  f.app.open(1);
  f.app.choose(0);
  const old = f.app.refresh();
  await flush();
  await f.app.submit();
  assert.equal(reads, 3);
  release(response(state()));
  await old;
  assert.equal(f.app.getView().model?.waiting, 0);
});

test("uncertain write reconciles facts without reposting; missing recent record stays unverified", async () => {
  let posts = 0,
    phase = 0;
  const f = app(async (_url, options) => {
    if (options?.method === "POST") {
      posts++;
      phase = 1;
      throw new Error("connection lost");
    }
    return response(phase ? { ...state(), cards: [], recentCards: [] } : state());
  });
  await f.app.ready;
  f.app.open(1);
  f.app.choose(0);
  await f.app.submit();
  assert.equal(posts, 1);
  assert.match(f.app.getView().message, /提交结果未能核实/);
  await f.app.submit();
  assert.equal(posts, 1);
});

test("poll errors preserve selection, process changes require reload, legacy questions are read only", async () => {
  let fail = false,
    instance = "instance";
  const f = app(async () => {
    if (fail) throw new Error("offline");
    return response(state(), 200, instance);
  });
  await f.app.ready;
  f.app.open(1);
  f.app.choose(1);
  fail = true;
  await f.app.refresh();
  assert.equal(f.app.getView().selection, 1);
  fail = false;
  instance = "new";
  await f.app.refresh();
  assert.equal(f.app.getView().reloadRequired, true);
  assert.equal(f.app.getView().canSubmit, false);
  const legacy = app(async () => response({ ...state(), cards: [{ ...card(), options: [], recommend: null }] }));
  await legacy.app.ready;
  legacy.app.open(1);
  assert.equal(legacy.app.getView().canSubmit, false);
});

test("visibility pauses ticks and resumes immediately; invalid first load is an error", async () => {
  const callbacks: Function[] = [];
  let reads = 0;
  const document = documentFixture();
  document.hidden = true;
  const f = startDashboardApp({
    document: document as any,
    fetchImpl: async () => {
      reads++;
      return response({});
    },
    setTimer: (fn) => {
      callbacks.push(fn);
      return 0;
    },
    clearTimer: () => {},
  });
  await f.ready;
  assert.equal(reads, 1);
  assert.equal(callbacks.length, 0);
  assert.equal(f.getView().model, null);
  assert.match(document.nodes.status.textContent, /读取失败/);
  document.hidden = false;
  document.dispatch("visibilitychange");
  await flush();
  assert.equal(reads, 2);
  assert.equal(callbacks.length, 1);
});

test("notice is acknowledged directly; competing decisions show facts without claiming this request succeeded", async () => {
  let phase = 0,
    posted = "";
  const notice = app(async (_url, options) => {
    if (options?.method === "POST") {
      posted = String(options.body);
      phase = 1;
      return response({ changed: true, state: "closed" });
    }
    return response({ ...state(), cards: phase ? [] : [card(1, "notice")] });
  });
  await notice.app.ready;
  notice.app.open(1);
  assert.equal(notice.app.getView().canSubmit, true);
  await notice.app.submit();
  assert.equal(posted, '{"choice":0}');
  assert.match(notice.app.getView().message, /通知已处理/);
  assert.equal(notice.app.getView().model?.waiting, 0);
  let done = false;
  const competing = app(async (_url, options) => {
    if (options?.method === "POST") {
      done = true;
      return response({ changed: false, state: "decided" });
    }
    return response(
      done
        ? {
            ...state(),
            cards: [],
            recentCards: [{ ...card(), state: "decided", choice: 1, by: "other", decidedAt: state().now }],
          }
        : state(),
    );
  });
  await competing.app.ready;
  competing.app.open(1);
  competing.app.choose(0);
  await competing.app.submit();
  assert.match(competing.app.getView().message, /此卡片已被处理，本次未更改/);
});

test("untrusted reports render as text and unsafe links never become clickable", async () => {
  const f = app(async () => response({ ...state(), cards: [{ ...card(), link: "javascript:alert(1)" }] }));
  await f.app.ready;
  f.app.open(1);
  const nodes: any[] = [];
  const walk = (node: any) => {
    nodes.push(node);
    for (const child of node.children) walk(child);
  };
  walk(f.document.nodes.detail);
  assert.ok(nodes.some((node) => node.textContent === card().text));
  assert.ok(!nodes.some((node) => node.href));
  assert.ok(!nodes.some((node) => node.type === "text"));
});

test("selection and polling preserve collapsed reports and keyboard focus", async () => {
  const f = app(async () => response(state()));
  await f.app.ready;
  f.app.open(1);
  const detail = f.document.nodes.detail;
  let report = detail.children.find((node: any) => node.tagName === "details");
  report.open = false;
  report.dispatch("toggle");
  const findInput = (node: any): any => (node.type === "radio" ? node : node.children.map(findInput).find(Boolean));
  const input = findInput(detail);
  input.focus();
  f.app.choose(0);
  report = detail.children.find((node: any) => node.tagName === "details");
  assert.equal(report.open, false);
  assert.equal(f.document.activeElement?.type, "radio");
  await f.app.refresh();
  assert.equal(f.document.activeElement?.type, "radio");
  assert.equal(detail.children.find((node: any) => node.tagName === "details").open, false);
});

test("polling preserves every interactive detail control and pending-card button focus", async () => {
  const f = app(async () => response({ ...state(), cards: [{ ...card(), link: "https://example.test/report" }] }));
  await f.app.ready;
  f.app.open(1);
  f.app.choose(0);
  const walk = (node: any): any[] => [node, ...node.children.flatMap(walk)];
  const controls = walk(f.document.nodes.detail).filter((node) => ["button", "summary", "a"].includes(node.tagName));
  assert.ok(controls.length >= 4);
  for (const control of controls) {
    const current = walk(f.document.nodes.detail).find(
      (node) => node.id === control.id && node.tagName === control.tagName,
    );
    current.focus();
    await f.app.refresh();
    assert.ok(f.document.activeElement, `lost ${control.tagName}: ${control.textContent}`);
    assert.equal(f.document.activeElement.id, control.id);
  }
  const open = walk(f.document.nodes.waiting).find((node) => node.tagName === "button");
  open.focus();
  await f.app.refresh();
  assert.equal(f.document.activeElement?.id, open.id);
});

// Failure mode: context exists in the model but never reaches the pending list.
test("pending list shows repository, MR number and title before opening details", async () => {
  const identity = "仓库：team/app\nMR：!7\nMR 标题：修复登录状态";
  const f = app(async () => response({ ...state(), cards: [{ ...card(), text: identity + "\n\n完整报告" }] }));
  await f.app.ready;
  const textOf = (node: any): string => node.textContent + node.children.map(textOf).join("");
  assert.match(textOf(f.document.nodes.waiting), /仓库：team\/app\nMR：!7\nMR 标题：修复登录状态/);
  assert.equal(f.document.nodes.detail.hidden, true);
});
