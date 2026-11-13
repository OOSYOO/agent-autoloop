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
    [finding, { ...finding, severity: "P3", line: null }],
    [{ body, position: { new_path: "spec.md", new_line: 7 } }],
  );
  assert.match(pages[0], /确认后，将在这条 MR 下发布 1 条/);
  assert.match(pages.join(""), /将发布[\s\S]*293 与 368 行矛盾[\s\S]*不发布[\s\S]*293 与 368 行矛盾/);
  const many = Array.from({ length: 10 }, (_, i) => ({ ...finding, title: `title${i}`, evidence: "字".repeat(1000) }));
  const split = findingsPages("url", many, []);
  assert.ok(split.length > 1 && split.every((page) => [...page].length <= 4000));
  assert.equal((split.join("").match(/字/g) ?? []).length, 10000);
  assert.throws(() => findingsPages("url", Array(50).fill({ ...finding, evidence: "X".repeat(1000) }), []), /超出/);
});

test("zero findings still asks for human review with the MR link", () => {
  const pages = findingsPages("https://example.com/group/project/-/merge_requests/1", [], []);
  assert.equal(pages.length, 1);
  assert.match(pages[0], /人工/);
  assert.match(pages[0], /https:\/\/example.com\/group\/project/);
});

test("ordinary discussion is marked for publication when inline location is unavailable", () => {
  const f = { ...finding, line: null };
  const body = `[P2] 冲突\n\n位置：spec.md（新版本，无行号）\n\n293 与 368 行矛盾\n\n影响：行为不明确\n\n建议：统一要求`;
  const pages = findingsPages("url", [f], [{ body, position: null }]);
  assert.match(pages[0], /将发布/);
});

// Failure mode: audit identifiers and evidence bury the decision; full comments must remain available.
test("decision preview is short and full evidence stays below the report boundary", () => {
  const text = findingsPages("https://example.com/team/app/-/merge_requests/2", [finding], [])[0];
  const [preview, detail] = text.split("\n\n完整报告：\n");
  assert.ok(detail);
  assert.match(preview, /P2.*冲突/);
  assert.match(preview, /行为不明确/);
  assert.match(preview, /统一要求/);
  assert.doesNotMatch(preview, /293 与 368|spec.md|findings|将发布/);
  assert.doesNotMatch(text, /a{40}|b{64}|c{64}/);
  assert.match(detail, /293 与 368 行矛盾/);
});

// Failure mode: pending approvals from different repositories/MRs look identical until opened.
test("MR identity and title appear before findings on every report page", () => {
  const context = { projectPath: "team/app", mrIid: 7, title: "修复登录状态\n<script>资料</script>" };
  const pages = findingsPages("https://gitlab.example.com/team/app/-/merge_requests/7", [finding], [], context);
  assert.match(pages[0].split("\n\n")[0], /仓库：team\/app\nMR：!7\nMR 标题：修复登录状态 <script>资料<\/script>/);
  const many = Array.from({ length: 10 }, () => ({ ...finding, evidence: "字".repeat(1000) }));
  const split = findingsPages("https://gitlab.example.com/team/app/-/merge_requests/7", many, [], context);
  assert.ok(split.length > 1);
  for (const page of split) {
    assert.match(page, /MR 标题：修复登录状态/);
    assert.ok([...page].length <= 4000);
  }
});
