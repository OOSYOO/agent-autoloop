// Failure mode: an unconfirmed or rejected publish appears as a successful publication.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerOutcome } from "../plugins/gitlab/outcome.ts";
test("each publication outcome is reported honestly", () => {
  assert.match(answerOutcome(["unknown"])!, /未确认/);
  assert.match(answerOutcome(["sent"])!, /已发布/);
  assert.match(answerOutcome(["rejected"])!, /不发布/);
  assert.match(answerOutcome(["sent-stale"])!, /旧版本/);
  assert.equal(answerOutcome(["ignored"]), null);
});
