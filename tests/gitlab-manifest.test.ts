// Failure modes: findings without eligible severity or verified diff positions are approved for publication.
import assert from "node:assert/strict";
import { test } from "node:test";
import { manifest } from "../plugins/gitlab/manifest.ts";
const refs = { base_sha: "a".repeat(40), start_sha: "b".repeat(40), head_sha: "c".repeat(40) };
const finding = {
  severity: "P2" as const,
  title: "错误",
  evidence: "证据",
  impact: "影响",
  suggestion: "建议",
  path: "a.ts",
  side: "new" as const,
  line: 1,
};
test("manifest binds content and position, excluding P3 and missing positions", () => {
  const diff = [{ old_path: "a.ts", new_path: "a.ts", diff: "@@ -0,0 +1 @@\n+line\n" }];
  const result = manifest(
    "work",
    42,
    7,
    "d".repeat(64),
    "e".repeat(64),
    refs,
    [finding, { ...finding, severity: "P3" }, { ...finding, line: 9 }],
    diff,
  );
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].actionKey, /^[a-f0-9]{64}$/);
  assert.notEqual(
    result.items[0].actionKey,
    manifest("work", 42, 7, "d".repeat(64), "e".repeat(64), refs, [{ ...finding, title: "另一个" }], diff).items[0]
      .actionKey,
  );
});
