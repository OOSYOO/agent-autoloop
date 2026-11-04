// Failure modes: overlapping workers overwrite immutable evidence or claim the same external write twice.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicFile, claimAction, canonical } from "../plugins/gitlab/storage.ts";
import { test } from "node:test";

test("private durable files and exclusive action claims", () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-test-"));
  try {
    atomicFile(join(root, "reports", "x"), "one", true);
    assert.equal(readFileSync(join(root, "reports", "x"), "utf8"), "one");
    assert.equal(statSync(join(root, "reports", "x")).mode & 0o777, 0o600);
    assert.throws(() => atomicFile(join(root, "reports", "x"), "two", true));
    assert.equal(claimAction(root, "a".repeat(64), "b".repeat(64)), true);
    assert.equal(claimAction(root, "a".repeat(64), "b".repeat(64)), false);
    assert.equal(canonical({ z: [{ b: 2, a: 1 }], a: 1 }), '{"a":1,"z":[{"a":1,"b":2}]}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
