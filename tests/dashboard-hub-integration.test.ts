// Failure modes: proxy approval changes choice/text semantics, races overwrite a decision,
// notices wake a worker, or the integration only exercises a substitute for the hub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setup, at } from "./helpers.ts";
import { createHubClient } from "../dashboard/src/hub-client.ts";
import { createDashboardServer } from "../dashboard/src/server.ts";
setup("dashboard-integration");
const runtime = await import("../host/runtime.ts");
const { serve } = await import("../host/http.ts");

test("real hub persists the exact option once, resumes the asking thread, and closes notices without work", async (t) => {
  const owner = runtime.addKey("owner", "dashboard");
  const hub = serve(0, "127.0.0.1", { commit: "dashboard-test" });
  await once(hub, "listening");
  const hubUrl = new URL(`http://127.0.0.1:${(hub.address() as AddressInfo).port}`);
  let race: number | null = null;
  const client = createHubClient({
    hubUrl,
    owner,
    fetchImpl: async (url, options) => {
      if (options?.method === "POST" && race !== null) {
        runtime.answer(race, { choice: 1, by: "other" });
        race = null;
      }
      return fetch(url, options);
    },
  });
  const server = createDashboardServer({ hubClient: client });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    client.close();
    server.closeAllConnections();
    server.close();
    hub.closeAllConnections();
    hub.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const read = await fetch(base + "/api/state");
  assert.equal(read.status, 200);
  const headers = {
    origin: base,
    "content-type": "application/json",
    "x-dashboard-action": "answer",
    "x-dashboard-instance": read.headers.get("x-dashboard-instance")!,
  };
  function ask(n: number) {
    runtime.ingest("app", { id: `dashboard-${n}`, type: "feedback.new", subject: `#${n}` }, at(n));
    const job = runtime.claimNext("w1", `dashboard-${n}`, at(n))!;
    runtime.finish(
      job.run,
      job.token,
      {
        outcome: "done",
        ask: [{ title: `报告${n}`, text: "报告正文", options: ["发布", "不发布"], recommend: 0, key: `q${n}` }],
      },
      at(n),
    );
    return runtime.stateOf().cards.find((c) => c.title === `报告${n}`)!.id;
  }
  const post = (id: number) =>
    fetch(`${base}/api/cards/${id}/answer`, { method: "POST", headers, body: '{"choice":0}' });
  const id = ask(1);
  assert.deepEqual(await (await post(id)).json(), { changed: true, state: "decided" });
  const snapshot = await (await fetch(base + "/api/state")).json();
  assert.ok(!snapshot.cards.some((c: any) => c.id === id));
  const resumed = runtime.claimNext("w1", "resume", Date.now())!;
  assert.equal(resumed.context.answers[0].choice, 0);
  assert.equal(resumed.context.answers[0].text, null);
  runtime.finish(resumed.run, resumed.token, { outcome: "done" }, Date.now());
  assert.equal((await post(id)).status, 409);
  const second = ask(3);
  race = second;
  assert.deepEqual(await (await post(second)).json(), { changed: false, state: "decided" });
  assert.equal(runtime.stateOf().recentCards.find((c) => c.id === second)!.choice, 1);
  const notice = runtime.createCard({ key: "dashboard-notice", kind: "notice", title: "通知", text: "仅阅读" }).card;
  const before = runtime.stateOf().totals.queued;
  assert.deepEqual(await (await post(notice)).json(), { changed: true, state: "closed" });
  assert.equal(runtime.stateOf().totals.queued, before);
  assert.equal(
    runtime
      .logAfter()
      .filter(
        (f: any) =>
          f.type === "answer" &&
          f.changes.some((c: any) => c.table === "cards" && c.row?.id === id && c.row.state === "decided"),
      ).length,
    1,
  );
});
