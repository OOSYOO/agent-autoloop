// Failure modes: a finding is hidden, publication eligibility is misrepresented, or oversize content is truncated.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findingsPages } from "../plugins/gitlab/presentation.ts";

const finding = {
  severity: "P2",
  title: "冲突",
  evidence: "293 与 368 行矛盾",
  impact: "行为不明确",
  suggestion: "统一要求",
  path: "spec.md",
  side: "new",
  line: 7,
} as const;
test("all findings are shown and only actual manifest items are marked for publication", () => {
  const body = "[P2] 冲突\n\n293 与 368 行矛盾\n\n影响：行为不明确\n\n建议：统一要求";
  const pages = findingsPages(
    "url",
    "a".repeat(40),
    "a".repeat(64),
    1,
    2,
    "b".repeat(64),
    [finding, { ...finding, severity: "P3", line: null }],
    [{ body, position: { new_path: "spec.md", new_line: 7 } }],
  );
  assert.match(pages[0], /^MR 1\/2，版本 a{40}，策略 b{64}，/);
  assert.match(pages.join(""), /将发布[\s\S]*293 与 368 行矛盾[\s\S]*不发布[\s\S]*293 与 368 行矛盾/);
  const many = Array.from({ length: 10 }, (_, i) => ({ ...finding, title: `title${i}`, evidence: "字".repeat(1000) }));
  const split = findingsPages("url", "a".repeat(40), "a".repeat(64), 1, 2, "b".repeat(64), many, []);
  assert.ok(split.length > 1 && split.every((page) => [...page].length <= 4000));
  assert.equal((split.join("").match(/字/g) ?? []).length, 10000);
  assert.throws(
    () =>
      findingsPages(
        "url",
        "a".repeat(40),
        "a".repeat(64),
        1,
        2,
        "b".repeat(64),
        Array(50).fill({ ...finding, evidence: "X".repeat(1000) }),
        [],
      ),
    /超出/,
  );
});
