// Failure modes: free text or an answer to different content authorizes a publication.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publishDecision } from "../plugins/gitlab/answer.ts";
const hash = "a".repeat(64);
const answer = {
  card: 1,
  title: "确认",
  options: ["发布这份报告中的评论", "不发布"],
  choice: 0,
  text: null,
  about: JSON.stringify({ schema: 1, kind: "publish", manifestHash: hash }),
  by: null,
  at: "2026-01-01T00:00:00Z",
};
test("only exact publish choice and manifest authorize", () => {
  assert.equal(publishDecision(answer, hash), 0);
  assert.equal(publishDecision({ ...answer, choice: 1 }, hash), 1);
  assert.equal(publishDecision({ ...answer, choice: null, text: "批准" }, hash), null);
  assert.equal(publishDecision({ ...answer, options: ["是", "否"] }, hash), null);
  assert.equal(publishDecision(answer, "b".repeat(64)), null);
  assert.equal(
    publishDecision({ ...answer, about: JSON.stringify({ schema: 1, kind: "context", manifestHash: hash }) }, hash),
    null,
  );
});

test("free text attached to a choice cannot grant approval", () => {
  assert.equal(publishDecision({ ...answer, text: "改成别的内容" }, hash), null);
});

test("rejecting an approved report does not require the network or current rule files", async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveArtifact } = await import("../plugins/gitlab/artifacts.ts");
  const { resumeAnswer } = await import("../plugins/gitlab/resume.ts");
  const root = mkdtempSync(join(tmpdir(), "gitlab-reject-"));
  try {
    const data = join(root, "gitlab");
    const reportHash = saveArtifact(data, "reports", {
      schema: 1,
      status: "reviewed",
      projectId: 42,
      mrIid: 7,
      headSha: "a".repeat(40),
      policyHash: "b".repeat(64),
    });
    const manifestHash = saveArtifact(data, "manifests", {
      schema: 1,
      reportHash,
      headSha: "a".repeat(40),
      policyHash: "b".repeat(64),
      items: [],
    });
    const cfg = { dataRoot: root, projects: [{ id: 42 }] } as any;
    const result = await resumeAnswer(cfg, {
      card: 1,
      title: "x",
      options: ["发布这份报告中的评论", "不发布"],
      choice: 1,
      text: null,
      about: JSON.stringify({ schema: 1, kind: "publish", manifestHash }),
      by: null,
      at: "2026-01-01T00:00:00Z",
    });
    assert.equal(result, "rejected");
    assert.equal(JSON.parse(readFileSync(join(data, "decisions", `${manifestHash}.json`), "utf8")).choice, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approval of a legacy report is stale without requiring network", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveArtifact } = await import("../plugins/gitlab/artifacts.ts");
  const { resumeAnswer } = await import("../plugins/gitlab/resume.ts");
  const root = mkdtempSync(join(tmpdir(), "gitlab-legacy-"));
  try {
    const dir = join(root, "gitlab"),
      sha = "a".repeat(40),
      policy = "b".repeat(64);
    const reportHash = saveArtifact(dir, "reports", {
      schema: 1,
      status: "reviewed",
      projectId: 42,
      mrIid: 7,
      headSha: sha,
      policyHash: policy,
    });
    const manifestHash = saveArtifact(dir, "manifests", {
      schema: 1,
      reportHash,
      headSha: sha,
      policyHash: policy,
      items: [],
    });
    const value = {
      ...answer,
      choice: 0,
      text: null,
      about: JSON.stringify({ schema: 1, kind: "publish", manifestHash }),
    };
    assert.equal(await resumeAnswer({ dataRoot: root, projects: [{ id: 42 }] } as any, value), "stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
