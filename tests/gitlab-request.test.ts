// Failure modes: a changed observation reuses an event ID, or a retry produces a different one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextObservation } from "../plugins/gitlab/request.ts";
test("reuses consecutive observation and advances A to B to A", () => {
  const a = {
    instanceKey: "work",
    projectId: 42,
    mrIid: 7,
    headSha: "a".repeat(40),
    policyHash: "b".repeat(64),
    eligible: true,
  };
  const one = nextObservation(undefined, a);
  assert.deepEqual(nextObservation(one, a), one);
  const two = nextObservation(one, { ...a, eligible: false });
  const three = nextObservation(two, a);
  assert.equal(three.observation, 3);
  assert.notEqual(three.requestId, one.requestId);
});

test("an automatic observation cannot erase a pending manual request", async () => {
  const { saveRequest, readRequests } = await import("../plugins/gitlab/request.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "gitlab-request-history-"));
  try {
    const manual = {
      schema: 1 as const,
      instanceKey: "work",
      projectId: 42,
      mrIid: 7,
      headSha: "a".repeat(40),
      policyHash: "b".repeat(64),
      eligible: true,
      observation: 1,
      requestId: "c".repeat(64),
      origin: "manual" as const,
      reviewerId: 8,
      overrides: ["draft"],
      reason: "确认",
    };
    const auto = { ...manual, observation: 2, requestId: "d".repeat(64), origin: "auto" as const, eligible: false };
    saveRequest(root, manual);
    saveRequest(root, auto);
    const records = readRequests(root, 42, 7);
    assert.equal(records.length, 2);
    assert.deepEqual(records.find((r) => r.requestId === manual.requestId)?.overrides, ["draft"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("request identity and manual authority cannot be rewritten under the same ID", async () => {
  const { saveRequest } = await import("../plugins/gitlab/request.ts"),
    { mkdtempSync, rmSync } = await import("node:fs"),
    { join } = await import("node:path"),
    { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "gitlab-request-immutable-"));
  try {
    const record = {
      schema: 1 as const,
      instanceKey: "work",
      projectId: 42,
      mrIid: 7,
      headSha: "a".repeat(40),
      policyHash: "b".repeat(64),
      eligible: true,
      observation: 1,
      requestId: "c".repeat(64),
      origin: "manual" as const,
      reviewerId: 8,
      overrides: ["draft"],
      reason: "确认",
    };
    saveRequest(root, record);
    saveRequest(root, { ...record, delivered: true });
    assert.throws(() => saveRequest(root, { ...record, overrides: ["ci"] }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted temporary file cannot hide a complete request", async () => {
  const { saveRequest, readRequests } = await import("../plugins/gitlab/request.ts"),
    { mkdtempSync, rmSync, writeFileSync } = await import("node:fs"),
    { join } = await import("node:path"),
    { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "gitlab-request-crash-"));
  try {
    const record = {
      schema: 1 as const,
      instanceKey: "work",
      projectId: 42,
      mrIid: 7,
      headSha: "a".repeat(40),
      policyHash: "b".repeat(64),
      eligible: true,
      observation: 1,
      requestId: "c".repeat(64),
    };
    saveRequest(root, record);
    writeFileSync(join(root, "requests", "42", "7", ".tmp-interrupted"), "partial");
    assert.equal(readRequests(root, 42, 7).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history recovers the highest observation if index write was interrupted", async () => {
  const { saveRequest, latestRequest } = await import("../plugins/gitlab/request.ts"),
    { mkdtempSync, rmSync, writeFileSync } = await import("node:fs"),
    { join } = await import("node:path"),
    { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "gitlab-request-index-"));
  try {
    const first = {
      schema: 1 as const,
      instanceKey: "work",
      projectId: 42,
      mrIid: 7,
      headSha: "a".repeat(40),
      policyHash: "b".repeat(64),
      eligible: true,
      observation: 1,
      requestId: "c".repeat(64),
    };
    const second = { ...first, observation: 2, requestId: "d".repeat(64) };
    saveRequest(root, first);
    saveRequest(root, second);
    writeFileSync(join(root, "requests", "42", "7.json"), JSON.stringify(first));
    assert.equal(latestRequest(root, 42, 7)?.requestId, second.requestId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale index cannot roll back the delivery state in request history", async () => {
  const { saveRequest, latestRequest } = await import("../plugins/gitlab/request.ts"),
    { mkdtempSync, rmSync, writeFileSync } = await import("node:fs"),
    { join } = await import("node:path"),
    { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "gitlab-request-state-"));
  try {
    const record = {
      schema: 1 as const,
      instanceKey: "work",
      projectId: 42,
      mrIid: 7,
      headSha: "a".repeat(40),
      policyHash: "b".repeat(64),
      eligible: true,
      observation: 1,
      requestId: "c".repeat(64),
    };
    saveRequest(root, record);
    saveRequest(root, { ...record, delivered: true });
    writeFileSync(join(root, "requests", "42", "7.json"), JSON.stringify(record));
    assert.equal(latestRequest(root, 42, 7)?.delivered, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
