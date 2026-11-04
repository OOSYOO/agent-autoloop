// Failure modes: Skill changes reuse stale results, or unrelated catalog files block every review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeBasis } from "../plugins/gitlab/native.ts";

test("native catalog and config are fingerprinted without exposing secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-native-"));
  try {
    const dir = join(root, "skill");
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), "initial");
    const fake = join(root, "codex");
    writeFileSync(
      fake,
      `#!${process.execPath}\nconst q=require('readline').createInterface({input:process.stdin});q.on('line',l=>{const x=JSON.parse(l);if(x.id===1)console.log(JSON.stringify({id:1,result:{}}));if(x.id===2)console.log(JSON.stringify({id:2,result:{config:{mcp_servers:{example:{enabled:true,token:'SECRET'}}}}}));if(x.id===3)console.log(JSON.stringify({id:3,result:{data:[{cwd:${JSON.stringify(root)},errors:[{path:'/optional/SKILL.md',message:'invalid optional skill'}],skills:[{name:'example',path:${JSON.stringify(join(dir, "SKILL.md"))},scope:'repo',enabled:true}]}]}}));});`,
      { mode: 0o700 },
    );
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "private.txt"), "not a skill resource");
    symlinkSync(outside, join(dir, "outside-dir"));
    const a = await nativeBasis(fake, root);
    assert.ok(!JSON.stringify(a).includes("SECRET"));
    assert.ok(a.files.some((file) => file.path.endsWith("private.txt")));
    writeFileSync(join(outside, "private.txt"), "changed referenced resource");
    assert.notEqual(a.digest, (await nativeBasis(fake, root)).digest);
    writeFileSync(join(dir, "SKILL.md"), "changed");
    const b = await nativeBasis(fake, root);
    assert.notEqual(a.digest, b.digest);
    symlinkSync(join(dir, "missing"), join(dir, "broken-link"));
    writeFileSync(join(dir, "asset.bin"), "");
    truncateSync(join(dir, "asset.bin"), 129 * 1024 * 1024);
    const c = await nativeBasis(fake, root);
    assert.notEqual(b.digest, c.digest);
    assert.ok(c.files.some((file) => file.path.endsWith("broken-link")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
