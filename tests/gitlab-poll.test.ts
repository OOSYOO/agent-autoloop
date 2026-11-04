// Failure modes: absent or stale CI, drafts and unrelated reviewers enter automatic review.
import assert from "node:assert/strict";
import { test } from "node:test";
import { eligible } from "../plugins/gitlab/poll.ts";
const sha = "a".repeat(40);
const mr = () => ({
  state: "opened",
  draft: false,
  sha,
  reviewers: [{ id: 8 }],
  head_pipeline: { sha, status: "success" },
});
test("requires reviewer, ready MR and successful current pipeline unless explicitly overridden", () => {
  assert.equal(eligible(mr(), 8, "required", []), true);
  assert.equal(eligible({ ...mr(), draft: true }, 8, "required", []), false);
  assert.equal(eligible({ ...mr(), reviewers: [] }, 8, "required", []), false);
  assert.equal(eligible({ ...mr(), head_pipeline: null }, 8, "required", []), false);
  assert.equal(eligible({ ...mr(), head_pipeline: null }, 8, "confirmed-none", []), true);
  assert.equal(
    eligible({ ...mr(), head_pipeline: { sha: "b".repeat(40), status: "success" } }, 8, "required", []),
    false,
  );
  assert.equal(eligible({ ...mr(), draft: true }, 8, "required", ["draft"]), true);
});

test("poll executable reports invalid configuration as a business ask", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["plugins/gitlab/poll.ts", "--config", "/does/not/exist"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /```agent-autoloop/);
  assert.match(result.stdout, /"ask"/);
});

test("discovery includes MRs after reviewer removal so reassignment is observable", async () => {
  const { discoveryPath } = await import("../plugins/gitlab/poll.ts");
  assert.equal(discoveryPath(42), "projects/42/merge_requests?state=opened&per_page=100");
});

test("allow-skipped is explicit and applies only to success or skipped on the current head", () => {
  for (const status of ["success", "skipped"]) {
    assert.equal(eligible({ ...mr(), head_pipeline: { sha, status } }, 8, "allow-skipped", []), true);
  }
  for (const status of ["failed", "pending", "running", "canceled", "cancelled", "unknown"]) {
    assert.equal(eligible({ ...mr(), head_pipeline: { sha, status } }, 8, "allow-skipped", []), false);
  }
  assert.equal(eligible({ ...mr(), head_pipeline: null }, 8, "allow-skipped", []), false);
  assert.equal(
    eligible({ ...mr(), head_pipeline: { sha: "b".repeat(40), status: "skipped" } }, 8, "allow-skipped", []),
    false,
  );
  assert.equal(eligible({ ...mr(), head_pipeline: { sha, status: "skipped" } }, 8, "required", []), false);
  assert.equal(eligible({ ...mr(), head_pipeline: { sha, status: "success" } }, 8, "confirmed-none", []), true);
  assert.equal(eligible({ ...mr(), head_pipeline: { sha, status: "skipped" } }, 8, "confirmed-none", []), false);
});
