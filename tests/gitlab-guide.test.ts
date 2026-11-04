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
