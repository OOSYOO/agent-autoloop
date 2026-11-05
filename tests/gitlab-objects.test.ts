// Failure modes: repository access executes hooks, exports a second full tree, rejects large repositories,
// accepts injected revisions, or reports missing Git objects as a successful review.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareObjects } from "../plugins/gitlab/objects.ts";
test("fetches trusted remote objects without executing repository hooks", async () => {
  const { prepareObjects } = await import("../plugins/gitlab/objects.ts");
  const root = mkdtempSync(join(tmpdir(), "gitlab-fetch-"));
  try {
    const remote = join(root, "remote.git"),
      cache = join(root, "cache.git");
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "--bare", cache]);
    const blob = execFileSync("git", ["--git-dir", remote, "hash-object", "-w", "--stdin"], {
      input: "data\n",
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["--git-dir", remote, "mktree"], {
      input: `100644 blob ${blob}\ta.txt\n`,
      encoding: "utf8",
    }).trim();
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const commit = execFileSync("git", ["--git-dir", remote, "commit-tree", tree], {
      input: "test",
      env,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["--git-dir", remote, "update-ref", "refs/heads/main", commit]);
    execFileSync("git", ["--git-dir", remote, "update-ref", "refs/merge-requests/7/head", commit]);
    execFileSync("git", ["--git-dir", cache, "remote", "add", "origin", remote]);
    writeFileSync(join(cache, "hooks", "post-fetch"), `#!/bin/sh\ntouch "${join(root, "hook-ran")}"\n`, {
      mode: 0o700,
    });
    prepareObjects(cache, 7, [commit]);
    assert.equal(existsSync(join(root, "hook-ran")), false);
    assert.equal(
      execFileSync("git", ["--git-dir", cache, "rev-parse", "refs/agent-autoloop/mr/7"], { encoding: "utf8" }).trim(),
      commit,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepares an object larger than 128 MiB without exporting a second copy", async () => {
  const { openSync, ftruncateSync, closeSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "gitlab-oversize-"));
  try {
    const bare = join(root, "repo.git");
    execFileSync("git", ["init", "--bare", bare]);
    const path = join(root, "large.bin");
    const fd = openSync(path, "w");
    try {
      ftruncateSync(fd, 128 * 1024 * 1024 + 1);
    } finally {
      closeSync(fd);
    }
    const blob = execFileSync("git", ["--git-dir", bare, "hash-object", "-w", path], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["--git-dir", bare, "mktree"], {
      input: `100644 blob ${blob}\tlarge.bin\n`,
      encoding: "utf8",
    }).trim();
    prepareObjects(bare, 7, [tree]);
    assert.equal(existsSync(join(root, "snapshot")), false);
    assert.equal(
      execFileSync("git", ["--git-dir", bare, "cat-file", "-s", blob], { encoding: "utf8" }).trim(),
      String(128 * 1024 * 1024 + 1),
    );
    assert.throws(() => prepareObjects(bare, 7, ["--help"]), /Git 对象摘要无效/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
