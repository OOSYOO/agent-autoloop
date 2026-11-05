// Failure modes: an approval job prevents review after tests pass; old, missing, retried or unfinished checks
// permit review or publication; a successful trigger hides a failing child pipeline; config changes reuse approval.
import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibleForReview } from "../plugins/gitlab/ci.ts";
import { parseConfig, policyHash } from "../plugins/gitlab/config.ts";
const sha = "a".repeat(40);
const project = { id: 2, ciMode: "checks" as const, ciJobs: ["build", "host"], ciBridges: ["board"] };
function fixture() {
  const mr = {
    iid: 790,
    state: "opened",
    draft: false,
    sha,
    reviewers: [{ id: 8 }],
    head_pipeline: { id: 10, sha, status: "canceled" },
  };
  const job = (name: string, id: number) => ({
    id,
    name,
    status: "success",
    commit: { id: sha },
    pipeline: { id: 10 },
  });
  const jobs = [job("build", 1), job("host", 2), { ...job("approval", 3), status: "canceled" }];
  const bridge = { ...job("board", 4), downstream_pipeline: { id: 11, project_id: 2, sha, status: "success" } };
  const child = { id: 11, project_id: 2, sha, status: "success" };
  const calls: string[] = [];
  const gl = {
    async list(path: string) {
      calls.push(path);
      return path.includes("/bridges?") ? [bridge] : jobs;
    },
    async get(path: string) {
      calls.push(path);
      return path.endsWith("/790") ? mr : child;
    },
  };
  return { mr, jobs, bridge, child, gl, calls };
}
test("configured checks allow review before human approval, and verify the actual child", async () => {
  const f = fixture();
  assert.equal(await eligibleForReview(f.gl, project, f.mr, 8, []), true);
  assert.ok(f.calls.includes("projects/2/pipelines/11"));
  assert.ok(f.calls.some((p) => p.includes("include_retried=false")));
  f.jobs.push({ ...f.jobs[0], id: 5, status: "failed" });
  assert.equal(
    await eligibleForReview(f.gl, project, f.mr, 8, []),
    false,
    "ambiguous duplicate names cannot hide failures",
  );
});
test("required checks never accept missing, failed, skipped, running or old jobs", async () => {
  for (const status of ["failed", "canceled", "skipped", "manual", "running", "pending"]) {
    const f = fixture();
    f.jobs[1].status = status;
    assert.equal(await eligibleForReview(f.gl, project, f.mr, 8, []), false, status);
  }
  const missing = fixture();
  missing.jobs.splice(1, 1);
  assert.equal(await eligibleForReview(missing.gl, project, missing.mr, 8, []), false);
  const old = fixture();
  old.jobs[1].commit.id = "b".repeat(40);
  assert.equal(await eligibleForReview(old.gl, project, old.mr, 8, []), false);
  const wrongPipeline = fixture();
  wrongPipeline.jobs[1].pipeline.id = 9;
  assert.equal(await eligibleForReview(wrongPipeline.gl, project, wrongPipeline.mr, 8, []), false);
});
test("child failure, stale SHA and a changed latest pipeline reject old eligibility", async () => {
  for (const status of ["failed", "running", "skipped", "canceled"]) {
    const f = fixture();
    f.child.status = status;
    assert.equal(await eligibleForReview(f.gl, project, f.mr, 8, []), false, status);
  }
  const old = fixture();
  old.child.sha = "b".repeat(40);
  assert.equal(await eligibleForReview(old.gl, project, old.mr, 8, []), false);
  const changed = fixture();
  const original = structuredClone(changed.mr);
  changed.mr.head_pipeline.id = 12;
  assert.equal(await eligibleForReview(changed.gl, project, original, 8, []), false);
  const draft = fixture();
  draft.mr.draft = true;
  assert.equal(await eligibleForReview(draft.gl, project, draft.mr, 8, []), false);
  const missingChild = fixture();
  missingChild.bridge.downstream_pipeline = null as any;
  assert.equal(await eligibleForReview(missingChild.gl, project, missingChild.mr, 8, []), false);
});
test("legacy projects do not fetch checks, and API failures cannot become success", async () => {
  const f = fixture();
  f.mr.head_pipeline.status = "success";
  assert.equal(await eligibleForReview(f.gl, { id: 2, ciMode: "required" }, f.mr, 8, []), true);
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    eligibleForReview(
      {
        ...f.gl,
        list: async () => {
          throw Error("offline");
        },
      },
      project,
      f.mr,
      8,
      [],
    ),
    /offline/,
  );
});
test("check configuration is explicit, validated and part of the policy fingerprint", () => {
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
    b = parseConfig({ ...raw, projects: [{ ...raw.projects[0], ciJobs: ["other"] }] });
  assert.notEqual(policyHash(a, a.projects[0], "rules"), policyHash(b, b.projects[0], "rules"));
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
