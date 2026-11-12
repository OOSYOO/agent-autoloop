// Failure modes: CI still blocks review or publication; obsolete CI settings change report identity;
// removing CI accidentally bypasses MR state, reviewer, draft or head validation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibleForReview } from "../plugins/gitlab/ci.ts";
import { parseConfig, policyHash } from "../plugins/gitlab/config.ts";
const sha = "a".repeat(40);
const project = { id: 2, ciMode: "checks" as const, ciJobs: ["build", "host"], ciBridges: ["board"] };
const mr = () => ({ iid: 790, state: "opened", draft: false, sha, reviewers: [{ id: 8 }] });
const noCI = {
  async list(): Promise<unknown[]> {
    assert.fail("CI endpoints must not be queried");
  },
  async get(): Promise<unknown> {
    assert.fail("CI endpoints must not be queried");
  },
};
test("all legacy modes ignore CI states, missing pipelines and stale pipeline SHAs without fetching checks", async () => {
  for (const ciMode of ["required", "confirmed-none", "allow-skipped", "checks"] as const) {
    for (const pipeline of [
      undefined,
      null,
      ...["success", "failed", "canceled", "skipped", "manual", "running", "pending"].map((status) => ({
        id: 10,
        sha: "b".repeat(40),
        status,
      })),
    ]) {
      const current = { ...mr(), ...(pipeline === undefined ? {} : { head_pipeline: pipeline }) };
      assert.equal(
        await eligibleForReview(noCI, { ...project, ciMode }, current, 8, []),
        true,
        `${ciMode}: ${JSON.stringify(pipeline)}`,
      );
    }
  }
});
test("CI removal preserves closed, draft, reviewer and head checks and historical overrides", async () => {
  for (const change of [
    { state: "closed" },
    { state: "merged" },
    { draft: true },
    { reviewers: [] },
    { sha: "invalid" },
    { draft: undefined },
    { reviewers: undefined },
  ]) {
    assert.equal(await eligibleForReview(noCI, project, { ...mr(), ...change }, 8, []), false);
  }
  assert.equal(await eligibleForReview(noCI, project, { ...mr(), draft: true, reviewers: [] }, 8, ["ci"]), false);
  assert.equal(await eligibleForReview(noCI, project, { ...mr(), reviewers: [] }, 8, ["reviewer", "ci"]), true);
  assert.equal(
    await eligibleForReview(noCI, project, { ...mr(), state: "closed" }, 8, ["reviewer", "draft", "ci"]),
    false,
  );
});
test("legacy check settings remain validated but do not affect new policy fingerprints", () => {
  const raw = {
    schema: 1,
    instanceKey: "work",
    instanceUrl: "https://gitlab.test",
    hubUrl: "http://127.0.0.1:3000",
    reviewerId: 8,
    sourceKeyPath: "/key",
    dataRoot: "/data",
    model: "model",
    codexPath: "/codex",
    glabPath: "/glab",
    projects: [{ ...project, cachePath: "/cache" }],
  };
  const a = parseConfig(raw),
    b = parseConfig({ ...raw, projects: [{ ...raw.projects[0], ciJobs: ["other"], ciBridges: [] }] });
  assert.equal(policyHash(a, a.projects[0], "rules"), policyHash(b, b.projects[0], "rules"));
  for (const change of [
    { ciJobs: [] },
    { ciJobs: ["host", "host"] },
    { ciJobs: [" "] },
    { ciBridges: ["board", "board"] },
    { ciMode: "required" },
  ]) {
    assert.throws(() => parseConfig({ ...raw, projects: [{ ...raw.projects[0], ...change }] }));
  }
});
