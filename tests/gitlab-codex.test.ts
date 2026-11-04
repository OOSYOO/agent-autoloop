// Failure modes: a failed or incomplete native Codex run becomes an empty successful review.
import assert from "node:assert/strict";
import { test } from "node:test";
import { codexArgs, completed } from "../plugins/gitlab/codex.ts";
test("requires native completion and uses normal Codex configuration", () => {
  const args = codexArgs("model", undefined, "/tmp/result");
  for (const flag of ["exec", "--json"]) assert.ok(args.includes(flag));
  assert.ok(!args.includes("--ignore-user-config"));
  assert.ok(!args.includes("--sandbox"));
  assert.ok(!args.includes("--disable"));
  assert.equal(completed('{"type":"turn.completed"}\n'), true);
  assert.equal(completed('{"type":"turn.failed"}\n'), false);
  assert.equal(completed("not json"), false);
});

test("rejects failed native process even when it emits completion", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { runCodex } = await import("../plugins/gitlab/codex.ts");
  const root = mkdtempSync(join(tmpdir(), "codex-test-"));
  try {
    const fake = join(root, "codex");
    writeFileSync(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"turn.completed"}));process.exit(1);`, {
      mode: 0o700,
    });
    await assert.rejects(runCodex(fake, root, "model", undefined, "instruction"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid native output is preserved privately with its event stream and a schema is passed to Codex", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, statSync } =
    await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { runCodex } = await import("../plugins/gitlab/codex.ts");
  const root = mkdtempSync(join(tmpdir(), "codex-invalid-"));
  try {
    const cwd = join(root, "snapshot"),
      diagnostics = join(root, "diagnostics");
    mkdirSync(cwd);
    const fake = join(root, "codex");
    writeFileSync(
      fake,
      `#!/usr/bin/env node\nconst fs=require('fs'),a=process.argv;const i=a.indexOf('--output-schema');if(i<0)process.exit(3);const schema=JSON.parse(fs.readFileSync(a[i+1],'utf8'));if(schema.additionalProperties!==false || !schema.properties.findings.items.properties.severity.enum.includes('P2'))process.exit(4);fs.writeFileSync(a[a.indexOf('-o')+1],'{"status":"bad"}');console.error('sensitive-stderr');console.log(JSON.stringify({type:'turn.completed'}));`,
      { mode: 0o700 },
    );
    let message = "";
    try {
      await runCodex(fake, cwd, "model", undefined, "instruction", diagnostics);
    } catch (error) {
      message = (error as Error).message;
    }
    const entries = readdirSync(diagnostics);
    assert.equal(entries.length, 1, message);
    const dir = join(diagnostics, entries[0]);
    assert.ok(message.includes(dir));
    assert.equal(readFileSync(join(dir, "output.json"), "utf8"), '{"status":"bad"}');
    const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
    assert.equal(metadata.failure, "invalid_output");
    assert.equal(metadata.exitCode, 0);
    assert.match(readFileSync(join(dir, "stdout.jsonl"), "utf8"), /turn.completed/);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "output.json")).mode & 0o777, 0o600);
    assert.equal(
      readdirSync(dir).some((name) => name.includes("stderr")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a native process failure preserves output and does not expose stderr", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { runCodex } = await import("../plugins/gitlab/codex.ts");
  const root = mkdtempSync(join(tmpdir(), "codex-failed-"));
  try {
    const cwd = join(root, "snapshot"),
      diagnostics = join(root, "diagnostics");
    mkdirSync(cwd);
    const fake = join(root, "codex");
    writeFileSync(
      fake,
      `#!/usr/bin/env node\nconst fs=require('fs'),a=process.argv;fs.writeFileSync(a[a.indexOf('-o')+1],'partial');console.log(JSON.stringify({type:'turn.failed'}));console.error('private-secret');process.exit(1);`,
      { mode: 0o700 },
    );
    await assert.rejects(runCodex(fake, cwd, "model", undefined, "instruction", diagnostics), /诊断保存在/);
    const dir = join(diagnostics, readdirSync(diagnostics)[0]);
    assert.equal(readFileSync(join(dir, "output.json"), "utf8"), "partial");
    const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
    assert.equal(metadata.failure, "process_exit");
    assert.equal(metadata.exitCode, 1);
    assert.match(readFileSync(join(dir, "stdout.jsonl"), "utf8"), /turn.failed/);
    assert.equal(
      readdirSync(dir).some((name) => name.includes("stderr")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful model calls preserve private prompt, schema, exact output, events and metadata", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { runCodex } = await import("../plugins/gitlab/codex.ts");
  const root = mkdtempSync(join(tmpdir(), "codex-audit-"));
  try {
    const cwd = join(root, "snapshot"),
      audit = join(root, "audit"),
      fake = join(root, "codex");
    mkdirSync(cwd);
    writeFileSync(
      fake,
      `#!/usr/bin/env node\nconst fs=require('fs'),a=process.argv;fs.writeFileSync(a[a.indexOf('-o')+1],'{"complete":true,"executionIssue":"","findings":[]}');console.log('{"type":"turn.completed"}');`,
      { mode: 0o700 },
    );
    const result = await runCodex(fake, cwd, "model", "high", "the prompt", audit);
    const dir = join(audit, result.audit);
    assert.equal(readFileSync(join(dir, "prompt.txt"), "utf8"), "the prompt");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "output.json"), "utf8")), result.report);
    const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
    assert.equal(metadata.model, "model");
    assert.equal(metadata.effort, "high");
    assert.equal(metadata.success, true);
    assert.equal(metadata.failure, null);
    assert.equal(metadata.exitCode, 0);
    assert.ok(Date.parse(metadata.startedAt) <= Date.parse(metadata.finishedAt));
    assert.match(readFileSync(join(dir, "stdout.jsonl"), "utf8"), /turn.completed/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "schema.json"), "utf8")).required, [
      "complete",
      "executionIssue",
      "findings",
    ]);
    for (const path of ["prompt.txt", "schema.json", "output.json", "stdout.jsonl", "metadata.json"])
      assert.equal(statSync(join(dir, path)).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicitly incomplete model review has its own safe failure category", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { runCodex } = await import("../plugins/gitlab/codex.ts");
  const root = mkdtempSync(join(tmpdir(), "codex-incomplete-"));
  try {
    const cwd = join(root, "snapshot"),
      audit = join(root, "audit"),
      fake = join(root, "codex");
    mkdirSync(cwd);
    writeFileSync(
      fake,
      `#!/usr/bin/env node\nconst fs=require('fs'),a=process.argv;fs.writeFileSync(a[a.indexOf('-o')+1],'{"complete":false,"executionIssue":"不可用","findings":[]}');console.log('{"type":"turn.completed"}');`,
      { mode: 0o700 },
    );
    await assert.rejects(runCodex(fake, cwd, "model", undefined, "prompt", audit), /不可用/);
    const metadata = JSON.parse(readFileSync(join(audit, readdirSync(audit)[0], "metadata.json"), "utf8"));
    assert.equal(metadata.failure, "model_incomplete");
    assert.equal(metadata.exitCode, 0);
    assert.equal(metadata.success, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
