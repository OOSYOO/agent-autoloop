// Failure modes: a model-selected line outside a complete diff, or a truncated diff, becomes a GitLab position.
import assert from "node:assert/strict";
import { test } from "node:test";
import { positionFor } from "../plugins/gitlab/diff.ts";

const diff = {
  old_path: "old.ts",
  new_path: "new.ts",
  diff: "@@ -1,3 +1,3 @@\n unchanged\n-old\n+new\n last\n",
  collapsed: false,
  too_large: false,
};
const refs = { base_sha: "a".repeat(40), start_sha: "b".repeat(40), head_sha: "c".repeat(40) };
test("only maps actual old and new lines from complete diffs", () => {
  assert.deepEqual(positionFor([diff], refs, "new.ts", "new", 2), {
    position_type: "text",
    ...refs,
    old_path: "old.ts",
    new_path: "new.ts",
    new_line: 2,
  });
  assert.deepEqual(positionFor([diff], refs, "old.ts", "old", 1), {
    position_type: "text",
    ...refs,
    old_path: "old.ts",
    new_path: "new.ts",
    old_line: 1,
    new_line: 1,
  });
  assert.equal(positionFor([diff], refs, "new.ts", "new", 9), null);
  assert.equal(positionFor([{ ...diff, too_large: true }], refs, "new.ts", "new", 2), null);
});

test("does not map a line from an incomplete hunk", () => {
  const partial = { ...diff, diff: "@@ -1,3 +1,3 @@\n unchanged\n-old\n+new\n" };
  assert.equal(positionFor([partial], refs, "new.ts", "new", 2), null);
});
