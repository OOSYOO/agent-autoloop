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

test("completed report cache excludes needs-context and changed policy", async () => {
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
    assert.equal(completedReport(root, 1, 2, a.headSha, a.policyHash), null);
    const reviewed = { ...a, status: "reviewed" };
    const digest = saveArtifact(root, "reports", reviewed);
    assert.equal(completedReport(root, 1, 2, a.headSha, a.policyHash)?.hash, digest);
    assert.equal(completedReport(root, 1, 2, a.headSha, "c".repeat(64)), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
