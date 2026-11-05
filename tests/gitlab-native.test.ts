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
    const a = await nativeBasis(fake, root, "使用example审查");
    assert.ok(!JSON.stringify(a).includes("SECRET"));
    assert.ok(a.files.some((file) => file.path.endsWith("private.txt")));
    writeFileSync(join(outside, "private.txt"), "changed referenced resource");
    assert.notEqual(a.digest, (await nativeBasis(fake, root, "使用example审查")).digest);
    writeFileSync(join(dir, "SKILL.md"), "changed");
    const b = await nativeBasis(fake, root, "使用example审查");
    assert.notEqual(a.digest, b.digest);
    symlinkSync(join(dir, "missing"), join(dir, "broken-link"));
    writeFileSync(join(dir, "asset.bin"), "");
    truncateSync(join(dir, "asset.bin"), 129 * 1024 * 1024);
    const c = await nativeBasis(fake, root, "使用example审查");
    assert.notEqual(b.digest, c.digest);
    assert.ok(c.files.some((file) => file.path.endsWith("broken-link")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unrelated Skill upgrades and local UI changes do not re-review unchanged MRs", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-native-stable-"));
  try {
    const selected = join(root, "review"),
      unrelated = join(root, "slides");
    mkdirSync(selected);
    mkdirSync(unrelated);
    writeFileSync(join(selected, "SKILL.md"), "review rules");
    writeFileSync(join(unrelated, "SKILL.md"), "slides v1");
    const state = join(root, "native.json"),
      fake = join(root, "codex");
    const config = {
      developer_instructions: "Be precise",
      model_provider: "openai",
      projects: { old: { trust_level: "trusted" } },
      plugins: { slides: { enabled: true } },
    };
    const skills = [
      { name: "code-review", path: join(selected, "SKILL.md"), scope: "user", enabled: true },
      { name: "slides", path: join(unrelated, "SKILL.md"), scope: "user", enabled: true },
    ];
    writeFileSync(state, JSON.stringify({ config, skills }));
    writeFileSync(
      fake,
      `#!${process.execPath}\nconst fs=require('fs'),q=require('readline').createInterface({input:process.stdin});q.on('line',l=>{const x=JSON.parse(l),s=JSON.parse(fs.readFileSync(${JSON.stringify(state)}));if(x.id===1)console.log(JSON.stringify({id:1,result:{}}));if(x.id===2)console.log(JSON.stringify({id:2,result:{config:s.config}}));if(x.id===3)console.log(JSON.stringify({id:3,result:{data:[{errors:[],skills:s.skills}]}}));});`,
      { mode: 0o700 },
    );
    const first = await nativeBasis(fake, root, "使用code-review详细审查");
    writeFileSync(join(unrelated, "SKILL.md"), "slides v2");
    writeFileSync(
      state,
      JSON.stringify({ config: { ...config, projects: {}, plugins: {} }, skills: skills.slice(0, 1) }),
    );
    assert.equal((await nativeBasis(fake, root, "使用code-review详细审查")).digest, first.digest);
    writeFileSync(join(selected, "SKILL.md"), "new review rules");
    const changed = await nativeBasis(fake, root, "使用code-review详细审查");
    assert.notEqual(changed.digest, first.digest);
    writeFileSync(
      state,
      JSON.stringify({ config: { ...config, developer_instructions: "Different instructions" }, skills }),
    );
    assert.notEqual((await nativeBasis(fake, root, "使用code-review详细审查")).digest, changed.digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
