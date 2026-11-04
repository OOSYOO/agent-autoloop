// Prevent cwd-dependent configuration and accidental execution during a local configuration check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkGitlab } from "../cli/gitlab.ts";

test("GitLab check resolves a portable configuration and diagnoses missing prompt", () => {
  const home = mkdtempSync(join(tmpdir(), "gitlab-cli-"));
  try {
    const dir = join(home, "gitlab");
    mkdirSync(dir);
    execFileSync("git", ["init", "--bare", join(dir, "cache.git")], { stdio: "ignore" });
    execFileSync("git", ["--git-dir", join(dir, "cache.git"), "remote", "add", "origin", "git@example.com:app.git"]);
    writeFileSync(join(dir, "source.key"), "secret", { mode: 0o600 });
    writeFileSync(join(dir, "SKILL.md"), "trusted instructions");
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        schema: 1,
        instanceKey: "work",
        instanceUrl: "https://example.com",
        reviewerId: 8,
        hubUrl: "http://127.0.0.1:3351",
        sourceKeyPath: "source.key",
        dataRoot: "data",
        model: "test-model",
        codexPath: process.execPath,
        glabPath: process.execPath,
        projects: [
          {
            id: 14,
            projectPath: "team/app",
            rulesBranch: "main",
            cachePath: "cache.git",
          },
        ],
      }),
    );
    const rulesFile = join(home, "rules.json");
    const routing = {
      agents: { review: { use: "gitlab", command: ["review", "--config", "gitlab/config.json"] } },
      rules: [
        { name: "review", when: { source: "gitlab", types: ["mr.review.14"] }, to: "review", prompt: "只读审查" },
      ],
    };
    writeFileSync(rulesFile, JSON.stringify(routing));
    const report = checkGitlab(join(dir, "config.json"), home, rulesFile);
    assert.equal(report.model, "test-model");
    assert.equal(report.projects[0].projectPath, "team/app");
    assert.equal(report.projects[0].remote, "git@example.com:app.git");
    assert.equal(report.projects[0].cachePath, join(dir, "cache.git"));
    assert.ok(!JSON.stringify(report).includes("secret"));
    routing.rules[0].prompt = "";
    writeFileSync(rulesFile, JSON.stringify(routing));
    assert.throws(() => checkGitlab(join(dir, "config.json"), home, rulesFile), /prompt/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
