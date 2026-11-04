// Failure modes: an arbitrary GitLab host or project can be used to issue a privileged manual review.
import assert from "node:assert/strict";
import { test } from "node:test";
import { manualTarget } from "../plugins/gitlab/manual.ts";
test("accepts only exact configured host and verified project path", () => {
  assert.equal(
    manualTarget("https://gitlab.example.com/team/repo/-/merge_requests/7", "https://gitlab.example.com", "team/repo"),
    7,
  );
  for (const url of [
    "https://evil.example.com/team/repo/-/merge_requests/7",
    "https://gitlab.example.com/team/other/-/merge_requests/7",
    "https://gitlab.example.com/team/repo/-/merge_requests/7?x=1",
  ])
    assert.throws(() => manualTarget(url, "https://gitlab.example.com", "team/repo"));
});

test("only local identity bound to request can authorize overrides", async () => {
  const { manualOverrides } = await import("../plugins/gitlab/manual.ts");
  const local = {
    schema: 1,
    origin: "manual",
    requestId: "a".repeat(64),
    reviewerId: 8,
    overrides: ["ci"],
    reason: "已检查",
  };
  assert.deepEqual(manualOverrides(local, local.requestId, 8), ["ci"]);
  assert.deepEqual(manualOverrides(local, "b".repeat(64), 8), []);
  assert.deepEqual(manualOverrides({ ...local, reason: "" }, local.requestId, 8), []);
  assert.deepEqual(manualOverrides(local, local.requestId, 9), []);
});
