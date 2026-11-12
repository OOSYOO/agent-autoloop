// Prevent a documented standard-plugin configuration from being rejected by the actual rule validator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRules } from "../protocol/rules.ts";

test("GitLab guide rules work with the standard plugin", () => {
  const guide = readFileSync(new URL("../docs/gitlab-review.md", import.meta.url), "utf8");
  const blocks = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  const rules = blocks.find((block) => block.agents);
  assert.ok(rules);
  const parsed = parseRules(JSON.stringify(rules), Date.UTC(2026, 0, 1), "UTC");
  assert.equal(parsed.agents["gitlab-review"].use, "gitlab");
  assert.equal(parsed.rules.length, 2);
});

test("Feishu intake guide merges with existing GitLab routes and uses the standard agent", async () => {
  const guide = readFileSync(new URL("../docs/gitlab-review.md", import.meta.url), "utf8");
  const blocks = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  const base = blocks.find((block) => block.agents?.["gitlab-review"]);
  const intake = blocks.find((block) => block.agents?.["feishu-review-scan"]);
  assert.ok(intake);
  const rules = parseRules(
    JSON.stringify({ ...base, agents: { ...base.agents, ...intake.agents }, rules: [...base.rules, ...intake.rules] }),
    Date.UTC(2026, 0, 1),
    "UTC",
  );
  assert.equal(rules.agents["feishu-review-scan"].use, "feishu");
  const { default: agent } = await import("../plugins/feishu/agent.ts");
  const argv = agent.command({ command: intake.agents["feishu-review-scan"].command } as any);
  assert.ok(argv.some((part) => part.endsWith("/plugins/feishu/review-runtime.ts")));
  assert.throws(() => agent.command({ command: ["shell", "--config", "foo"] } as any));
});
