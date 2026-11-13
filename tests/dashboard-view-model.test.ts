// Failure modes: unknown executions look idle, retries are double-counted, or history crowds the pending list.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOverviewModel, safeLink, validateState } from "../dashboard/public/view-model.js";
import { state, card } from "./dashboard-fixture.ts";
test("only open cards and scheduled rules; timezone and upstream round counts survive mapping", () => {
  const s = state();
  s.cards.push({ ...card(2), state: "decided" });
  const fixture = {
    ...s,
    lines: [
      {
        id: "scheduled",
        name: "定时",
        every: "每天",
        next: "2026-11-14T01:00:00.000Z",
        totals: { running: 0, queued: 0, retrying: 0, unknown: 1 },
      },
      {
        id: "event",
        name: "事件",
        every: null,
        next: null,
        totals: { running: 2, queued: 0, retrying: 0, unknown: 0 },
      },
    ],
    elsewhere: [{ id: "scheduled", name: "外部", every: "每天", next: "2026-11-14T01:00:00.000Z", where: "别处" }],
  };
  const m = buildOverviewModel(validateState(fixture));
  assert.equal(m.waiting, 1);
  assert.equal(m.doneToday, 3);
  assert.equal(m.scheduled.length, 2);
  assert.match(m.scheduled[0].status, /执行结果不确定/);
  assert.doesNotMatch(m.scheduled[0].status, /等待下次/);
  assert.match(m.scheduled[0].next, /2026.*11.*14.*09:00:00/);
  assert.match(m.scheduled[1].status, /状态未知/);
  fixture.lines[0].totals = { running: 0, queued: 2, retrying: 1, unknown: 0 };
  assert.match(buildOverviewModel(fixture).scheduled[0].status, /排队 2（含重派 1）/);
  assert.equal(safeLink("javascript:alert(1)"), null);
  assert.equal(safeLink("https://example.test"), "https://example.test/");
});
