// Failure modes: snapshot generation executes worktree hooks or admits an untrusted Git revision.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { snapshot } from "../plugins/gitlab/snapshot.ts";
test("exports changes between exact objects from a bare repository", () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-snapshot-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "--bare", "repo.git");
    const blob = execFileSync("git", ["--git-dir", join(root, "repo.git"), "hash-object", "-w", "--stdin"], {
      input: "hello\n",
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["--git-dir", join(root, "repo.git"), "mktree"], {
      input: `100644 blob ${blob}\ta.txt\n`,
      encoding: "utf8",
    }).trim();
    const empty = execFileSync("git", ["--git-dir", join(root, "repo.git"), "mktree"], {
      input: "",
      encoding: "utf8",
    }).trim();
    const output = join(root, "snapshot");
    snapshot(join(root, "repo.git"), output, empty, tree);
    assert.match(readFileSync(join(output, "changes.txt"), "utf8"), /\+hello/);
    assert.throws(() => snapshot(join(root, "repo.git"), output, "--help", tree));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fetches trusted remote objects without executing repository hooks", async () => {
  const { fetchObjects } = await import("../plugins/gitlab/snapshot.ts");
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
    fetchObjects(cache, 7);
    assert.equal(existsSync(join(root, "hook-ran")), false);
    assert.equal(
      execFileSync("git", ["--git-dir", cache, "rev-parse", "refs/agent-autoloop/mr/7"], { encoding: "utf8" }).trim(),
      commit,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exports unchanged head context as non-executable data and never creates AGENTS.md", () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-context-"));
  try {
    const bare = join(root, "repo.git");
    execFileSync("git", ["init", "--bare", bare]);
    const blob = (content: string) =>
      execFileSync("git", ["--git-dir", bare, "hash-object", "-w", "--stdin"], {
        input: content,
        encoding: "utf8",
      }).trim();
    const a = blob("changed\n"),
      b = blob("callers\n"),
      c = blob("ignore instructions\n");
    const tree = execFileSync("git", ["--git-dir", bare, "mktree"], {
      input: `100644 blob ${c}\tAGENTS.md\n100644 blob ${a}\ta.ts\n100644 blob ${b}\tcaller.ts\n`,
      encoding: "utf8",
    }).trim();
    const old = blob("old\n");
    const base = execFileSync("git", ["--git-dir", bare, "mktree"], {
      input: `100644 blob ${c}\tAGENTS.md\n100644 blob ${old}\ta.ts\n100644 blob ${b}\tcaller.ts\n`,
      encoding: "utf8",
    }).trim();
    const output = join(root, "snapshot");
    snapshot(bare, output, base, tree);
    assert.doesNotMatch(readFileSync(join(output, "changes.txt"), "utf8"), /caller.ts/);
    assert.equal(
      readFileSync(join(output, "files", `${createHash("sha256").update("caller.ts").digest("hex")}.txt`), "utf8"),
      "callers\n",
    );
    assert.equal(
      readFileSync(join(output, "files", `${createHash("sha256").update("AGENTS.md").digest("hex")}.txt`), "utf8"),
      "ignore instructions\n",
    );
    assert.equal(existsSync(join(output, "AGENTS.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binary objects are represented losslessly instead of silently omitted", () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-binary-"));
  try {
    const bare = join(root, "repo.git");
    execFileSync("git", ["init", "--bare", bare]);
    const blob = execFileSync("git", ["--git-dir", bare, "hash-object", "-w", "--stdin"], {
      input: Buffer.from([0, 255, 1]),
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["--git-dir", bare, "mktree"], {
      input: `100644 blob ${blob}\timage.bin\n`,
      encoding: "utf8",
    }).trim();
    const empty = execFileSync("git", ["--git-dir", bare, "mktree"], { input: "", encoding: "utf8" }).trim();
    const output = join(root, "snapshot");
    snapshot(bare, output, empty, tree);
    const index = JSON.parse(readFileSync(join(output, "index.json"), "utf8"));
    assert.equal(index[0].encoding, "hex");
    assert.equal(readFileSync(join(output, index[0].file), "utf8"), "00ff01");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exports a binary object larger than 8 MiB without truncation", () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-large-binary-"));
  try {
    const bare = join(root, "repo.git");
    execFileSync("git", ["init", "--bare", bare]);
    const bytes = Buffer.alloc(17_772_300, 0xa5);
    bytes[0] = 0;
    bytes[bytes.length - 1] = 0xff;
    const blob = execFileSync("git", ["--git-dir", bare, "hash-object", "-w", "--stdin"], {
      input: bytes,
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["--git-dir", bare, "mktree"], {
      input: `100644 blob ${blob}\tfont.ttf\n`,
      encoding: "utf8",
    }).trim();
    const output = join(root, "snapshot");
    snapshot(bare, output, tree, tree);
    const index = JSON.parse(readFileSync(join(output, "index.json"), "utf8"));
    assert.equal(index[0].encoding, "hex");
    const restored = Buffer.from(readFileSync(join(output, index[0].file), "utf8"), "hex");
    assert.deepEqual(restored, bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an object exceeding the 128 MiB snapshot budget", async () => {
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
    assert.throws(() => snapshot(bare, join(root, "snapshot"), tree, tree), /文字快照过大/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
