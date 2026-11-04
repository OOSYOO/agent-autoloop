// Failure modes: an adapter runs an arbitrary command, resolves config from an untrusted working directory, or changes the configured model.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const home = mkdtempSync(join(tmpdir(), "gitlab agent "));
process.env.AGENT_AUTOLOOP_HOME = home;
const { adapterFor } = await import("../worker/agents.ts");
const adapter = await adapterFor("gitlab");
const configFile = join(home, "gitlab", "config.json");
mkdirSync(join(home, "gitlab"));
writeFileSync(
  configFile,
  JSON.stringify({
    schema: 1,
    instanceKey: "work",
    instanceUrl: "https://gitlab.example.com",
    reviewerId: 8,
    hubUrl: "http://127.0.0.1:3000",
    sourceKeyPath: "key",
    dataRoot: "data",
    model: "model",
    effort: "high",
    codexPath: "/bin/codex",
    glabPath: "/bin/glab",
    projects: [{ id: 42, cachePath: "cache.git" }],
  }),
);
const turn = {
  prompt: "",
  session: "id",
  resume: null,
  cwd: "/other",
  access: "read" as const,
  contextFile: "/ctx",
  folder: "/run",
};
test("standard adapter dispatches only scan and review with home-relative configuration", () => {
  try {
    const scan = adapter.command({ ...turn, command: ["scan", "--config", "gitlab/config.json"] });
    assert.equal(scan[0], process.execPath);
    assert.ok(scan[1].endsWith("/plugins/gitlab/poll.ts"));
    assert.deepEqual(scan.slice(2), ["--config", configFile]);
    const review = adapter.command({ ...turn, command: ["review", "--config", "gitlab/config.json"] });
    assert.equal(review[0], process.execPath);
    assert.ok(review[1].endsWith("/plugins/gitlab/run.ts"));
    assert.deepEqual(review.slice(2), ["--config", configFile, "--model", "model", "--effort", "high"]);
    assert.throws(() => adapter.command({ ...turn, command: ["other", "--config", "gitlab/config.json"] }));
    assert.throws(() =>
      adapter.command({ ...turn, command: ["review", "--config", "gitlab/config.json", "anything"] }),
    );
    assert.throws(() =>
      adapter.command({ ...turn, model: "different", command: ["review", "--config", "gitlab/config.json"] }),
    );
    assert.throws(() =>
      adapter.command({ ...turn, effort: "low", command: ["review", "--config", "gitlab/config.json"] }),
    );
    assert.deepEqual(adapter.read("done", 0, ""), { text: "done" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
