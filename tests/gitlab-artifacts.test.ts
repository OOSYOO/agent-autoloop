// Failure modes: persisted reports can be silently altered, or needs-context reports count as completed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { saveArtifact, loadArtifact } from "../plugins/gitlab/artifacts.ts";
test("content address binds immutable bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-artifacts-"));
  try {
    const hash = saveArtifact(root, "reports", { schema: 1, status: "reviewed" });
    assert.deepEqual(loadArtifact(root, "reports", hash), { schema: 1, status: "reviewed" });
    writeFileSync(join(root, "reports", `${hash}.json`), '{"schema":1}');
    assert.throws(() => loadArtifact(root, "reports", hash));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed report cache excludes needs-context but accepts changed policy", async () => {
  const { completedReport } = await import("../plugins/gitlab/artifacts.ts");
  const root = mkdtempSync(join(tmpdir(), "gitlab-cache-"));
  try {
    const a = {
      schema: 1,
      projectId: 1,
      mrIid: 2,
      headSha: "a".repeat(40),
      policyHash: "b".repeat(64),
      status: "needs-context",
    };
    saveArtifact(root, "reports", a);
    assert.equal(completedReport(root, 1, 2, a.headSha), null);
    const reviewed = { ...a, status: "reviewed" };
    const digest = saveArtifact(root, "reports", reviewed);
    assert.equal(completedReport(root, 1, 2, a.headSha)?.hash, digest);
    assert.equal(completedReport(root, 1, 2, a.headSha)?.hash, digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a completed same-head report survives policy changes", async () => {
  const { completedReport } = await import("../plugins/gitlab/artifacts.ts");
  const root = mkdtempSync(join(tmpdir(), "gitlab-head-cache-"));
  try {
    const r = {
      schema: 1,
      projectId: 1,
      mrIid: 2,
      headSha: "a".repeat(40),
      policyHash: "b".repeat(64),
      status: "reviewed",
    };
    const digest = saveArtifact(root, "reports", r);
    assert.equal(completedReport(root, 1, 2, r.headSha)?.hash, digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-head cache selects the latest completed report rather than hash order", async () => {
  const { completedReport } = await import("../plugins/gitlab/artifacts.ts");
  const root = mkdtempSync(join(tmpdir(), "gitlab-head-order-"));
  try {
    const base = {
      schema: 1,
      projectId: 1,
      mrIid: 2,
      headSha: "a".repeat(40),
      status: "reviewed",
      policyHash: "b".repeat(64),
    };
    const old = { ...base, createdAt: "2026-01-01T00:00:00.000Z", findings: [{ title: "old" }] };
    const newer = { ...base, createdAt: "2026-02-01T00:00:00.000Z", findings: [{ title: "new" }] };
    const digest = saveArtifact(root, "reports", newer);
    let oldHash = "";
    for (let i = 0; i < 1000 && (!oldHash || oldHash > digest); i++)
      oldHash = saveArtifact(root, "reports", { ...old, nonce: i });
    assert.ok(oldHash < digest, "the old report sorts before the new report");
    assert.equal(completedReport(root, 1, 2, base.headSha)?.hash, digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
