// Failure modes: review keeps stale files, overwrites another directory, or changes the user's development checkout.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareWorktree } from "../plugins/gitlab/worktree.ts";

test("one managed review worktree follows the trusted branch without modifying development", () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-worktree-"));
  try {
    const dev = join(root, "development"),
      bare = join(root, "cache.git"),
      review = join(root, "codereview-worktree");
    mkdirSync(dev);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dev, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(dev, "a.txt"), "one");
    git("add", "a.txt");
    git("commit", "-m", "one");
    execFileSync("git", ["clone", "--bare", dev, bare], { stdio: "ignore" });
    const first = prepareWorktree(bare, "main", review);
    assert.equal(readFileSync(join(review, "a.txt"), "utf8"), "one");
    writeFileSync(join(dev, "a.txt"), "two");
    git("commit", "-am", "two");
    const previousWorkTree = process.env.GIT_WORK_TREE;
    try {
      process.env.GIT_WORK_TREE = dev;
      const second = prepareWorktree(bare, "main", review);
      assert.notEqual(first, second);
    } finally {
      if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousWorkTree;
    }
    assert.equal(readFileSync(join(review, "a.txt"), "utf8"), "two");
    assert.equal(git("branch", "--show-current"), "main");
    assert.equal(readFileSync(join(dev, "a.txt"), "utf8"), "two");
    writeFileSync(join(review, "a.txt"), "review scratch");
    writeFileSync(join(review, "scratch.txt"), "temporary review file");
    writeFileSync(join(dev, "a.txt"), "three");
    git("commit", "-am", "three");
    prepareWorktree(bare, "main", review);
    assert.equal(readFileSync(join(review, "a.txt"), "utf8"), "three");
    assert.throws(() => readFileSync(join(review, "scratch.txt"), "utf8"), { code: "ENOENT" });
    assert.equal(
      execFileSync("git", ["-C", review, "status", "--porcelain", "--untracked-files=all"], {
        encoding: "utf8",
      }).trim(),
      "",
    );
    const unmanaged = join(root, "other");
    mkdirSync(unmanaged);
    writeFileSync(join(unmanaged, "mine"), "keep");
    assert.throws(() => prepareWorktree(bare, "main", unmanaged));
    assert.equal(readFileSync(join(unmanaged, "mine"), "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
