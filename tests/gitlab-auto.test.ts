// Failure modes: automatic publication bypasses manual comparison after previous-version tool comments.
import assert from "node:assert/strict";
import { test } from "node:test";
import { requiresComparison } from "../plugins/gitlab/auto.ts";
test("only previously authored tool comments on another head require comparison", () => {
  const current = "a".repeat(40),
    older = "b".repeat(40),
    marker = `<!-- agent-autoloop:action=${"c".repeat(64)} -->`;
  const discussion = (id: number, head: string) => [
    { notes: [{ author: { id }, body: marker, position: { head_sha: head } }] },
  ];
  assert.equal(requiresComparison(discussion(8, older), 8, current), true);
  assert.equal(requiresComparison(discussion(8, current), 8, current), false);
  assert.equal(requiresComparison(discussion(9, older), 8, current), false);
});
