// Failure modes: malformed, oversized or untrusted model output is mistaken for a complete review;
// invalid finding paths or positions become publishable comments.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelReport } from "../plugins/gitlab/report.ts";

const valid = () => ({
  complete: true,
  executionIssue: "" as const,
  findings: [
    {
      severity: "P2",
      title: "错误",
      evidence: "证据",
      impact: "影响",
      suggestion: "建议",
      path: "src/a.ts",
      side: "new",
      line: 2,
    },
  ],
});

test("accepts only the model report contract", () => {
  assert.deepEqual(parseModelReport(JSON.stringify(valid())), valid());
  for (const value of [
    { ...valid(), command: "run" },
    { ...valid(), findings: [{ ...valid().findings[0], path: "../secret" }] },
    { ...valid(), findings: [{ ...valid().findings[0], path: "/secret" }] },
    { ...valid(), findings: [{ ...valid().findings[0], line: 0 }] },
    { ...valid(), findings: [{ ...valid().findings[0], severity: "P4" }] },
  ])
    assert.throws(() => parseModelReport(JSON.stringify(value)));
  assert.throws(() => parseModelReport("x".repeat(1024 * 1024 + 1)));
});

test("counts Unicode code points and supports unlocated findings", () => {
  const value = valid();
  value.findings[0].title = "😀".repeat(200);
  assert.equal(parseModelReport(JSON.stringify(value)).findings[0].title, value.findings[0].title);
  assert.equal(
    parseModelReport(JSON.stringify({ ...value, findings: [{ ...value.findings[0], line: null }] })).findings[0].line,
    null,
  );
});

test("reviewed cannot claim completion while listing missing context", () => {
  assert.throws(() => parseModelReport(JSON.stringify({ ...valid(), missingContext: ["配置缺失"] })));
});

test("review contract contains findings only and rejects obsolete context reports", () => {
  assert.deepEqual(parseModelReport(JSON.stringify({ complete: true, executionIssue: "", findings: [] })), {
    complete: true,
    executionIssue: "",
    findings: [],
  });
  assert.throws(() =>
    parseModelReport(
      JSON.stringify({ status: "needs-context", summary: "冲突", findings: [], missingContext: ["确认"] }),
    ),
  );
});

test("an incomplete model review cannot become zero findings", () => {
  assert.deepEqual(parseModelReport(JSON.stringify({ complete: true, executionIssue: "", findings: [] })), {
    complete: true,
    executionIssue: "",
    findings: [],
  });
  assert.throws(() => parseModelReport(JSON.stringify({ complete: false, findings: [] })));
});

test("incomplete review reports its specific execution limitation", () => {
  assert.throws(
    () => parseModelReport(JSON.stringify({ complete: false, executionIssue: "必需 Skill 不可用", findings: [] })),
    /必需 Skill 不可用/,
  );
});
