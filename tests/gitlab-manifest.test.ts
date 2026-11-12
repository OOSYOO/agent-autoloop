// Failure modes: severity groups mix or finding content and location are lost when publishing without a diff.
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
test("manifest binds content and location, excludes P3, and retains missing diff positions", () => {
  const result = manifest("work", 42, 7, "d".repeat(64), "e".repeat(64), refs, [
    finding,
    { ...finding, severity: "P3" },
    { ...finding, line: 9 },
  ]);
  assert.equal(result.items.length, 2);
  assert.match(result.items[0].actionKey, /^[a-f0-9]{64}$/);
  assert.notEqual(
    result.items[0].actionKey,
    manifest("work", 42, 7, "d".repeat(64), "e".repeat(64), refs, [{ ...finding, title: "另一个" }]).items[0].actionKey,
  );
});

test("severity policy separates automatic and manual findings and retains unpositioned findings", async () => {
  const { severityManifests } = await import("../plugins/gitlab/manifest.ts");
  const p0 = { ...finding, severity: "P0" as const };
  const p2 = { ...finding, severity: "P2" as const, title: "manual" };
  const args = ["work", 42, 7, "d".repeat(64), "e".repeat(64), refs] as const;
  const result = severityManifests(...args, [p0, p2]);
  assert.equal(result.automatic.items.length, 1);
  assert.match(result.automatic.items[0].body, /^\[P0\]/);
  assert.equal(result.manual.items.length, 1);
  assert.match(result.manual.items[0].body, /^\[P2\]/);
  const fallback = severityManifests(...args, [{ ...p0, line: null }]).automatic.items[0];
  assert.equal(fallback.position, null);
  assert.match(fallback.body, /a.ts/);
});

test("review findings use ordinary discussions without downloading a diff", () => {
  const item = manifest("work", 42, 7, "d".repeat(64), "e".repeat(64), refs, [finding]).items[0];
  assert.equal(item.position, null);
  assert.match(item.body, /a.ts/);
});

test("severity approval accepts only the exact P2 subset of the report", async () => {
  const { severityItemsMatch } = await import("../plugins/gitlab/manifest.ts");
  const findings = [{ ...finding, severity: "P0" as const }, finding];
  const manual = manifest("work", 42, 7, "d".repeat(64), "e".repeat(64), refs, [finding]);
  const mixed = manifest("work", 42, 7, "d".repeat(64), "e".repeat(64), refs, findings);
  assert.equal(
    severityItemsMatch("work", 42, 7, "d".repeat(64), "e".repeat(64), refs, findings, manual.items, "manual"),
    true,
  );
  assert.equal(
    severityItemsMatch("work", 42, 7, "d".repeat(64), "e".repeat(64), refs, findings, mixed.items, "manual"),
    false,
  );
  assert.equal(
    severityItemsMatch(
      "work",
      42,
      7,
      "d".repeat(64),
      "e".repeat(64),
      refs,
      findings,
      [{ ...manual.items[0], body: "changed" }],
      "manual",
    ),
    false,
  );
});
