// Failure modes: a lost POST response or a crash before recording success causes a duplicate discussion.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { publishOne } from "../plugins/gitlab/publish.ts";
test("never reposts an unknown action merely because no discussion is visible", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-publish-"));
  let writes = 0;
  try {
    const item = { actionKey: "a".repeat(64), body: "text", position: { head_sha: "b".repeat(40) } };
    const io = {
      current: async () => true,
      find: async () => null,
      post: async () => {
        writes++;
        throw Error("lost");
      },
    };
    assert.equal(await publishOne(root, "c".repeat(64), item, io), "unknown");
    assert.equal(await publishOne(root, "c".repeat(64), item, io), "unknown");
    assert.equal(writes, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a response with the wrong position is not recorded as sent", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-position-"));
  try {
    const item = { actionKey: "a".repeat(64), body: "text", position: { head_sha: "b".repeat(40) } };
    const io = {
      current: async () => true,
      find: async () => null,
      post: async () => ({ discussionId: "d", noteId: 3, position: { head_sha: "c".repeat(40) } }),
    };
    assert.equal(await publishOne(root, "c".repeat(64), item, io), "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("already published matching discussion is recorded without another POST", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-found-"));
  let posts = 0;
  try {
    const item = { actionKey: "a".repeat(64), body: "text", position: { head_sha: "b".repeat(40) } };
    const io = {
      current: async () => true,
      find: async () => ({ discussionId: "d", noteId: 4, position: item.position }),
      post: async () => {
        posts++;
        throw Error("unexpected");
      },
    };
    assert.equal(await publishOne(root, "c".repeat(64), item, io), "sent");
    assert.equal(posts, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("after a crash, an already sent action still checks for a moved head", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-stale-"));
  try {
    const item = { actionKey: "a".repeat(64), body: "text", position: { head_sha: "b".repeat(40) } };
    let fresh = true;
    const io = {
      current: async () => fresh,
      find: async () => null,
      post: async () => ({ discussionId: "d", noteId: 4, position: item.position }),
    };
    assert.equal(await publishOne(root, "c".repeat(64), item, io), "sent");
    const sent = join(root, "actions", item.actionKey, "sent.json");
    const record = JSON.parse(readFileSync(sent, "utf8"));
    assert.equal(typeof record.verifiedAt, "string");
    fresh = false;
    assert.equal(await publishOne(root, "c".repeat(64), item, io), "sent");
    delete record.verifiedAt;
    writeFileSync(sent, JSON.stringify(record));
    fresh = false;
    assert.equal(await publishOne(root, "c".repeat(64), item, io), "sent-stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown write saves safe status evidence without exposing remote text", async () => {
  const { GitLabWriteError } = await import("../plugins/gitlab/api.ts");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "gitlab-post-error-"));
  try {
    const item = { actionKey: "a".repeat(64), body: "test", position: { head_sha: "b".repeat(40) } };
    const result = await publishOne(root, "c".repeat(64), item, {
      current: async () => true,
      find: async () => null,
      post: async () => {
        throw new GitLabWriteError(400);
      },
    });
    assert.equal(result, "unknown");
    const raw = readFileSync(join(root, "actions", item.actionKey, "post-failure.json"), "utf8");
    const evidence = JSON.parse(raw);
    assert.equal(evidence.status, 400);
    assert.equal(evidence.kind, "http_response");
    assert.ok(!raw.includes("secret"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-POST stale check releases its unsent claim for a later eligible attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-unsent-"));
  try {
    const item = { actionKey: "a".repeat(64), body: "text", position: { head_sha: "b".repeat(40) } };
    let checks = 0,
      posts = 0;
    const io = {
      current: async () => ++checks !== 2,
      find: async () => null,
      post: async () => {
        posts++;
        return { discussionId: "d", noteId: 1, position: item.position };
      },
    };
    assert.equal(await publishOne(root, "c".repeat(64), item, io), "stale");
    assert.equal(posts, 0);
    assert.equal(await publishOne(root, "c".repeat(64), item, { ...io, current: async () => true }), "sent");
    assert.equal(posts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed pre-POST freshness read releases the unsent claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-unsent-error-"));
  try {
    const item = { actionKey: "a".repeat(64), body: "text", position: { head_sha: "b".repeat(40) } };
    let checks = 0,
      posts = 0;
    const io = {
      current: async () => {
        if (++checks === 2) throw Error("network");
        return true;
      },
      find: async () => null,
      post: async () => {
        posts++;
        return { discussionId: "d", noteId: 1, position: item.position };
      },
    };
    await assert.rejects(publishOne(root, "c".repeat(64), item, io), /network/);
    assert.equal(posts, 0);
    assert.equal(await publishOne(root, "c".repeat(64), item, { ...io, current: async () => true }), "sent");
    assert.equal(posts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a verified ordinary discussion without an inline position is sent once", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-ordinary-"));
  try {
    const item = { actionKey: "a".repeat(64), body: "text", position: null };
    let posts = 0;
    const io = {
      current: async () => true,
      find: async () => null,
      post: async () => {
        posts++;
        return { discussionId: "d", noteId: 2, position: null };
      },
    };
    assert.equal(await publishOne(root, "c".repeat(64), item, io), "sent");
    assert.equal(await publishOne(root, "c".repeat(64), item, io), "sent");
    assert.equal(posts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
