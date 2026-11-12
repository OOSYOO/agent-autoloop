// Failure modes: review instructions are silently ignored, another project's prompt is used,
// or ambiguous routing makes scanning and review disagree about the trusted policy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { instructionsFromRules } from "../plugins/gitlab/instructions.ts";

const settings = (prompt = "按项目规则详细审查，使用 code-review。") => ({
  agents: {
    review: { use: "gitlab", command: ["review", "--config", "gitlab/config.json"] },
  },
  rules: [
    {
      name: "review-14",
      when: { source: "gitlab", types: ["mr.review.14"] },
      to: "review",
      prompt,
    },
  ],
});
const instructions = (value: ReturnType<typeof settings>) =>
  instructionsFromRules(value, 14, "/private/hub/gitlab/config.json", "/private/hub");

test("uses the exact trusted routing prompt without a separate Skill setting", () => {
  assert.equal(instructions(settings()), "按项目规则详细审查，使用 code-review。");
  assert.equal(instructions(settings("只检查并发问题。")), "只检查并发问题。");
});

test("rejects absent, empty, ambiguous or differently configured review instructions", () => {
  assert.throws(() => instructions(settings("")));
  const other = settings();
  other.rules[0].when.types = ["mr.review.99"];
  assert.throws(() => instructions(other));
  const duplicate = settings();
  duplicate.rules.push({ ...duplicate.rules[0], name: "duplicate" });
  assert.throws(() => instructions(duplicate));
  const elsewhere = settings();
  elsewhere.agents.review.command[2] = "other/config.json";
  assert.throws(() => instructions(elsewhere));
});

test("GitLab rejects a separate rule.skill source", () => {
  const routed = settings();
  Object.assign(routed.rules[0], { skill: "code-review" });
  assert.throws(() => instructions(routed), /rule.skill/);
});

test("dispatched trusted job retains its original prompt after rules change", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { jobInstructions } = await import("../plugins/gitlab/instructions.ts");
  const root = mkdtempSync(join(tmpdir(), "gitlab-job-snapshot-"));
  try {
    writeFileSync(join(root, "entry.json"), JSON.stringify({ job: { rule: { name: "review-14", prompt: "原规则" } } }));
    assert.equal(jobInstructions(join(root, "context.json")).prompt, "原规则");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
