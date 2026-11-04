// Failure modes: installed code still depends on the source tree, an unmanaged app is overwritten,
// or a failed update destroys an existing installation or its private configuration.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { installLocal } from "../cli/local-install.ts";

const root = resolve(import.meta.dirname, "..");
const entries = ["bin", "cli", "host", "kernel", "protocol", "worker", "plugins", "skills", "package.json"];
function fixture(target: string) {
  mkdirSync(target);
  for (const entry of entries) cpSync(join(root, entry), join(target, entry), { recursive: true });
}

test("installation runs after its source moves, and updates preserve private home files", () => {
  const temp = mkdtempSync(join(tmpdir(), "local install ' "));
  try {
    const source = join(temp, "source"),
      home = join(temp, "home");
    fixture(source);
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), "private");
    const program = installLocal(source, home);
    assert.equal(program, join(home, "app", "bin", "agent-autoloop.ts"));
    const manifest = JSON.parse(readFileSync(join(home, "app", "local-install.json"), "utf8"));
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.kind, "agent-autoloop-local-install");
    assert.match(manifest.contentSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.sourceCommit, null);
    assert.equal(manifest.sourceDirty, null);
    assert.ok(!Number.isNaN(Date.parse(manifest.installedAt)));
    renameSync(source, join(temp, "moved"));
    const result = spawnSync(process.execPath, [program, "--version"], { encoding: "utf8", cwd: temp });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /agent-autoloop/);
    const wrapper = join(home, "bin", "agent-autoloop");
    const wrapped = spawnSync(wrapper, ["--version"], {
      encoding: "utf8",
      cwd: temp,
      env: { ...process.env, AGENT_AUTOLOOP_HOME: "/wrong" },
    });
    assert.equal(wrapped.status, 0, wrapped.stderr);
    assert.match(wrapped.stdout, /agent-autoloop/);
    installLocal(join(temp, "moved"), home);
    assert.equal(readFileSync(join(home, "config.json"), "utf8"), "private");
    assert.equal(existsSync(join(home, "app", "node_modules")), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("refuses unmanaged or self-installation and preserves the installed copy on a failed update", () => {
  const temp = mkdtempSync(join(tmpdir(), "local install guard "));
  try {
    const source = join(temp, "source"),
      home = join(temp, "home");
    fixture(source);
    mkdirSync(home);
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "agent-autoloop"), "my own command");
    assert.throws(() => installLocal(source, home));
    assert.equal(readFileSync(join(home, "bin", "agent-autoloop"), "utf8"), "my own command");
    rmSync(join(home, "bin", "agent-autoloop"));
    mkdirSync(join(home, "app"));
    writeFileSync(join(home, "app", "keep"), "unmanaged");
    assert.throws(() => installLocal(source, home));
    assert.equal(readFileSync(join(home, "app", "keep"), "utf8"), "unmanaged");
    rmSync(join(home, "app"), { recursive: true });
    const program = installLocal(source, home);
    assert.throws(() => installLocal(join(home, "app"), home));
    rmSync(join(source, "worker"), { recursive: true });
    assert.throws(() => installLocal(source, home));
    assert.equal(spawnSync(process.execPath, [program, "--version"], { encoding: "utf8", cwd: temp }).status, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("records commit, untracked runtime changes and a stable content digest", () => {
  const temp = mkdtempSync(join(tmpdir(), "local install identity "));
  try {
    const source = join(temp, "source"),
      home = join(temp, "home");
    fixture(source);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    git("init");
    git("add", "--", ...entries);
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base");
    const commit = git("rev-parse", "HEAD");
    installLocal(source, home);
    const read = () => JSON.parse(readFileSync(join(home, "app", "local-install.json"), "utf8"));
    const first = read();
    assert.equal(first.sourceCommit, commit);
    assert.equal(first.sourceDirty, false);
    installLocal(source, home);
    assert.equal(read().contentSha256, first.contentSha256);
    writeFileSync(join(source, "plugins", "untracked.txt"), "new content");
    installLocal(source, home);
    const changed = read();
    assert.equal(changed.sourceDirty, true);
    assert.notEqual(changed.contentSha256, first.contentSha256);
    git("add", "--", "plugins/untracked.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "tracked");
    writeFileSync(join(source, ".gitignore"), "plugins/ignored-runtime.txt\n");
    git("add", ".gitignore");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "ignore");
    writeFileSync(join(source, "plugins", "ignored-runtime.txt"), "ignored runtime");
    installLocal(source, home);
    assert.equal(read().sourceDirty, true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
