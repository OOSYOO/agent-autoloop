// Failure modes: untrusted URLs, paths or identities silently change review or publication policy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig, policyHash } from "../plugins/gitlab/config.ts";
const input = () => ({
  schema: 1,
  instanceKey: "work",
  instanceUrl: "https://gitlab.example.com",
  reviewerId: 8,
  hubUrl: "http://127.0.0.1:3000",
  sourceKeyPath: "/private/source",
  dataRoot: "/private/data",
  model: "model",
  codexPath: "/bin/codex",
  glabPath: "/bin/glab",
  projects: [{ id: 42, cachePath: "/private/repo.git" }],
});
test("validates trusted settings and defaults", () => {
  const config = parseConfig(input());
  assert.equal(config.projects[0].publication, "manual");
  assert.equal(config.projects[0].ciMode, "required");
  for (const bad of [
    { ...input(), instanceUrl: "http://example.com" },
    { ...input(), instanceUrl: "https://example.com/a" },
    { ...input(), reviewerId: 0 },
    { ...input(), model: "" },
    { ...input(), projects: [input().projects[0], input().projects[0]] },
  ])
    assert.throws(() => parseConfig(bad));
  assert.notEqual(policyHash(config, config.projects[0], "a"), policyHash(config, config.projects[0], "b"));
});

test("HTTP requires an exact explicit trusted origin", () => {
  const http = { ...input(), instanceUrl: "http://192.0.2.50" };
  assert.throws(() => parseConfig(http));
  assert.throws(() => parseConfig({ ...http, trustedHttpOrigin: "http://192.0.2.51" }));
  assert.equal(parseConfig({ ...http, trustedHttpOrigin: http.instanceUrl }).instanceUrl, http.instanceUrl);
});

test("legacy allow-skipped is readable but does not change the policy fingerprint", () => {
  const base = input();
  const config = parseConfig({ ...base, projects: [{ ...base.projects[0], ciMode: "allow-skipped" }] });
  const required = parseConfig(base);
  assert.equal(config.projects[0].ciMode, "allow-skipped");
  assert.equal(policyHash(config, config.projects[0], "skill"), policyHash(required, required.projects[0], "skill"));
});

test("configuration-relative paths follow the configuration file, not the working directory", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, isAbsolute } = await import("node:path");
  const { loadConfig } = await import("../plugins/gitlab/config.ts");
  const root = mkdtempSync(join(tmpdir(), "gitlab config "));
  try {
    const dir = join(root, "nested config");
    mkdirSync(dir);
    const base = input();
    const file = join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        ...base,
        sourceKeyPath: "keys/source",
        dataRoot: "data",
        codexPath: "node",
        glabPath: "./bin/glab",
        projects: [{ ...base.projects[0], cachePath: "cache/repo.git" }],
      }),
    );
    const config = loadConfig(file);
    assert.equal(config.sourceKeyPath, join(dir, "keys/source"));
    assert.equal(config.dataRoot, join(dir, "data"));
    assert.equal("skillPath" in config.projects[0], false);
    assert.equal(config.projects[0].cachePath, join(dir, "cache/repo.git"));
    assert.equal(config.glabPath, join(dir, "bin/glab"));
    assert.ok(isAbsolute(config.codexPath));
    const moved = join(root, "moved");
    mkdirSync(moved);
    const movedFile = join(moved, "config.json");
    writeFileSync(
      movedFile,
      JSON.stringify({
        ...base,
        sourceKeyPath: "keys/source",
        dataRoot: "data",
        codexPath: "node",
        glabPath: "./bin/glab",
        projects: [{ ...base.projects[0], cachePath: "cache/repo.git" }],
      }),
    );
    const other = loadConfig(movedFile);
    assert.equal(policyHash(config, config.projects[0], "skill"), policyHash(other, other.projects[0], "skill"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted project identity and scoped rule declarations participate in the policy", () => {
  const base = input();
  const config = parseConfig({
    ...base,
    projects: [{ ...base.projects[0], projectPath: "team/app", rulesBranch: "main" }],
  });
  assert.equal(config.projects[0].projectPath, "team/app");
  assert.equal(config.projects[0].rulesBranch, "main");
  assert.notEqual(
    policyHash(config, config.projects[0], "skill", "rules-a"),
    policyHash(config, config.projects[0], "skill", "rules-b"),
  );
  assert.throws(() =>
    parseConfig({
      ...base,
      projects: [{ ...base.projects[0], projectPath: "../bad", rulesBranch: "main" }],
    }),
  );
});

test("legacy GitLab Skill settings are rejected with migration guidance", () => {
  for (const obsolete of [
    { skillPath: "/old/SKILL.md" },
    { skill: "old" },
    { rules: [{ path: "AGENTS.md", scope: "." }] },
  ]) {
    assert.throws(
      () => parseConfig({ ...input(), projects: [{ ...input().projects[0], ...obsolete }] }),
      /不再支持.*rules.prompt/,
    );
  }
});

test("severity publication is explicit and changes the policy fingerprint", () => {
  const base = input();
  const manual = parseConfig(base);
  const severity = parseConfig({ ...base, projects: [{ ...base.projects[0], publication: "severity" }] });
  assert.equal(severity.projects[0].publication, "severity");
  assert.notEqual(
    policyHash(manual, manual.projects[0], "instructions"),
    policyHash(severity, severity.projects[0], "instructions"),
  );
});
