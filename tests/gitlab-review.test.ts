// Failure modes: merged events, old heads or locally unrecognized requests cause review of the wrong MR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectRequest } from "../plugins/gitlab/review.ts";
const base = {
  schema: 1 as const,
  requestId: "a".repeat(64),
  projectId: 1,
  mrIid: 2,
  headSha: "b".repeat(40),
  policyHash: "c".repeat(64),
  observation: 1,
  origin: "auto" as const,
};
test("selects latest locally recorded request matching current head", () => {
  const newer = { ...base, requestId: "d".repeat(64), observation: 2 };
  const forged = { ...newer, requestId: "e".repeat(64), observation: 3 };
  const other = { ...newer, projectId: 9, requestId: "f".repeat(64), observation: 4 };
  const events = [base, newer, forged, other].map((r) => ({ detail: JSON.stringify(r) }));
  assert.deepEqual(selectRequest(events, [base, newer, other], base.headSha, 1, 2), newer);
  assert.equal(selectRequest(events, [base, newer], "f".repeat(40), 1, 2), null);
});

test("review entry treats missing configuration as failure", async () => {
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(process.execPath, ["plugins/gitlab/run.ts", "--config", "/absent", "--model", "model"], {
    encoding: "utf8",
  });
  assert.equal(child.status, 1);
  assert.doesNotMatch(child.stdout, /"ask"|findings/);
  assert.notEqual(child.stderr.trim(), "");
});

test("unrecognized publish answer never becomes an approval", async () => {
  const { resumeAnswer } = await import("../plugins/gitlab/resume.ts");
  assert.equal(
    await resumeAnswer({} as never, {
      card: 1,
      title: "x",
      options: ["是", "否"],
      choice: 0,
      text: null,
      about: "{}",
      by: null,
      at: "2026-01-01T00:00:00Z",
    }),
    "ignored",
  );
});

test("only old-version publish cards for the same MR are resolved", async () => {
  const { obsoleteCards } = await import("../plugins/gitlab/review.ts");
  const open = [
    { card: 1, title: "确认发布审查评论", text: `MR 1/2，版本 ${"a".repeat(40)}，共 1 条。`, at: "now" },
    { card: 2, title: "确认发布审查评论", text: `MR 1/3，版本 ${"a".repeat(40)}，共 1 条。`, at: "now" },
  ];
  assert.deepEqual(obsoleteCards(open, 1, 2, "b".repeat(40)), [{ card: 1, reason: "MR 版本已变化" }]);
});

test("same head with changed policy retains the old publish card", async () => {
  const { obsoleteCards } = await import("../plugins/gitlab/review.ts");
  const open = [
    {
      card: 4,
      title: "确认发布审查评论",
      text: `MR 1/2，版本 ${"a".repeat(40)}，策略 ${"c".repeat(64)}，共 1 条。`,
      at: "now",
    },
  ];
  assert.deepEqual(obsoleteCards(open, 1, 2, "a".repeat(40)), []);
});

test("event type, source ID and subject must bind to the same configured project", async () => {
  const { eventMatches } = await import("../plugins/gitlab/review.ts");
  const event = {
    id: `gitlab:${base.requestId}`,
    source: "gitlab",
    type: "mr.review.1",
    subject: "work/1/2",
    detail: JSON.stringify(base),
  };
  assert.equal(eventMatches(event, "work"), true);
  assert.equal(eventMatches({ ...event, type: "mr.review.9" }, "work"), false);
  assert.equal(eventMatches({ ...event, subject: "work/9/2" }, "work"), false);
  assert.equal(eventMatches({ ...event, id: `gitlab:${"f".repeat(64)}` }, "work"), false);
});

test("new findings confirmation closes only on changed head for its MR", async () => {
  const { obsoleteCards } = await import("../plugins/gitlab/review.ts");
  const card = {
    card: 9,
    title: "确认发布审查评论",
    text: `MR 1/2，版本 ${"a".repeat(40)}，策略 ${"c".repeat(64)}，\nMR：https://git.example/team/app/-/merge_requests/2\nfindings 1/1`,
    at: "now",
  };
  assert.deepEqual(obsoleteCards([card], 1, 2, "b".repeat(40)), [{ card: 9, reason: "MR 版本已变化" }]);
  assert.deepEqual(obsoleteCards([card], 1, 2, "a".repeat(40)), []);
  assert.deepEqual(obsoleteCards([card], 1, 3, "b".repeat(40)), []);
});

test("a locally recorded event remains valid when review policy changes", () => {
  assert.deepEqual(selectRequest([{ detail: JSON.stringify(base) }], [base], base.headSha, 1, 2), base);
});

// Failure mode: removing audit hashes from display prevents stale confirmations from closing.
test("structured open-card context identifies stale reports independently of display text", async () => {
  const { obsoleteCards } = await import("../plugins/gitlab/review.ts");
  const card = {
    card: 10,
    title: "待确认：发布 1 条审查评论",
    text: "简短摘要",
    at: "now",
    about: JSON.stringify({ schema: 1, kind: "publish", manifestHash: "c".repeat(64) }),
  };
  const lookup = () => ({ projectId: 1, mrIid: 2, headSha: "a".repeat(40) });
  assert.deepEqual(obsoleteCards([card], 1, 2, "b".repeat(40), lookup), [{ card: 10, reason: "MR 版本已变化" }]);
  assert.deepEqual(obsoleteCards([card], 1, 3, "b".repeat(40), lookup), []);
  assert.deepEqual(obsoleteCards([card], 1, 2, "a".repeat(40), lookup), []);
});
