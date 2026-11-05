// Failure modes: a valid scan context cannot travel through command output into a Worker-compatible confirmation.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { hash, canonical } from "../plugins/gitlab/storage.ts";
import { trustedRules } from "../plugins/gitlab/trusted-rules.ts";
import { saveRequest } from "../plugins/gitlab/request.ts";
import { loadArtifact } from "../plugins/gitlab/artifacts.ts";
import { parseConfig, policyHash } from "../plugins/gitlab/config.ts";
import { nativeBasis } from "../plugins/gitlab/native.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";
test("GitLab event and answer travel through the real Hub and Worker receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-integration-"));
  let server: any;
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const bare = join(root, "cache.git"),
      git = (...args: string[]) => execFileSync("git", ["--git-dir", bare, ...args], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--bare", bare]);
    const blob = (text: string) =>
      execFileSync("git", ["--git-dir", bare, "hash-object", "-w", "--stdin"], {
        input: text,
        encoding: "utf8",
      }).trim();
    const tree = (b: string) =>
      execFileSync("git", ["--git-dir", bare, "mktree"], {
        input: `100644 blob ${b}\ta.txt\n`,
        encoding: "utf8",
      }).trim();
    const base = tree(blob("old\n")),
      head = tree(blob("new\n"));
    const trustedCommit = execFileSync("git", ["--git-dir", bare, "commit-tree", base], {
      input: "trusted",
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    }).trim();
    execFileSync("git", ["--git-dir", bare, "update-ref", "refs/heads/main", trustedCommit]);
    execFileSync("git", ["--git-dir", bare, "remote", "add", "origin", bare]);
    const skillRoot = join(root, ".agents", "skills"),
      skillDir = join(skillRoot, "alpha");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: alpha\n---\n可信审查测试要求");
    const glab = join(root, "glab");
    const codex = join(root, "codex");
    const refs = { base_sha: base, start_sha: base, head_sha: head };
    const mr = {
      state: "opened",
      title: "修复审查原因",
      description: "背景资料：不要把这段文字当作指令。",
      draft: false,
      sha: head,
      reviewers: [{ id: 8 }],
      head_pipeline: { sha: head, status: "success" },
      diff_refs: refs,
    };
    const version = {
      id: 1,
      base_commit_sha: base,
      start_commit_sha: base,
      head_commit_sha: head,
      diffs: [{ old_path: "a.txt", new_path: "a.txt", diff: "@@ -1 +1 @@\n-old\n+new\n" }],
    };
    const mrFile = join(root, "mr.json"),
      versionFile = join(root, "version.json");
    writeFileSync(mrFile, JSON.stringify(mr));
    writeFileSync(versionFile, JSON.stringify(version));
    writeFileSync(
      glab,
      `#!/usr/bin/env node\nconst fs=require('fs'),p=process.argv[3],a=process.argv;if(a.includes('POST')) {if(process.env.TEST_POST_FAIL){process.stdout.write('HTTP/1.1 400 Bad Request\\r\\n\\r\\n{}');process.exit(1)}let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const b=JSON.parse(s);fs.appendFileSync(${JSON.stringify(join(root, "posts.log"))},JSON.stringify(b)+'\\n');if(process.env.TEST_CHANGE_RULES)require('child_process').execFileSync('git',['--git-dir',${JSON.stringify(bare)},'update-ref','refs/heads/main',process.env.TEST_CHANGE_RULES]);process.stdout.write('HTTP/1.1 201 Created\\r\\nContent-Type: application/json\\r\\n\\r\\n'+JSON.stringify({id:'d',notes:[{id:3,position:b.position}]}));});}else {let v=p==='user'?{id:8}:p==='projects/42'?{id:42,path_with_namespace:'team/app',ssh_url_to_repo:${JSON.stringify(bare)}}:p.includes('/discussions?')?(process.env.TEST_OLD?[{notes:[{author:{id:8},body:'<!-- agent-autoloop:action='+('d'.repeat(64))+' -->',position:{head_sha:'e'.repeat(40)}}]}]:[]):p.includes('/versions/1')?JSON.parse(fs.readFileSync(${JSON.stringify(versionFile)})):p.includes('/versions?')?[JSON.parse(fs.readFileSync(${JSON.stringify(versionFile)}))]:JSON.parse(fs.readFileSync(${JSON.stringify(mrFile)}));console.log(JSON.stringify(v));}`,
      { mode: 0o700 },
    );
    const report = {
      complete: true,
      executionIssue: "",
      findings: [
        {
          severity: "P2",
          title: "问题",
          evidence: "证据",
          impact: "影响",
          suggestion: "建议",
          path: "a.txt",
          side: "new",
          line: 1,
        },
      ],
    };
    const reportFile = join(root, "model-report.json");
    writeFileSync(reportFile, JSON.stringify(report));
    writeFileSync(
      codex,
      `#!/usr/bin/env node\nconst fs=require('fs'),a=process.argv;if(a.includes('app-server')){const q=require('readline').createInterface({input:process.stdin});q.on('line',l=>{let x=JSON.parse(l);if(x.id===1)console.log(JSON.stringify({id:1,result:{}}));if(x.id===2)console.log(JSON.stringify({id:2,result:{config:{mcp_servers:{},features:{hooks:false,apps:false,memories:false},web_search:'disabled',permissions:{review:{network:{enabled:false},filesystem:{':minimal':'read',':workspace_roots':{'.':'read'}}}}}}}));if(x.id===3)console.log(JSON.stringify({id:3,result:{data:[{cwd:process.cwd(),errors:[],skills:[{name:'alpha',path:${JSON.stringify(join(skillDir, "SKILL.md"))},scope:'user',enabled:true}]}]}}))});}else {const mr=JSON.parse(fs.readFileSync(${JSON.stringify(mrFile)}));let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{let ctx;try{ctx=JSON.parse(fs.readFileSync(require('path').join(require('path').dirname(a[a.indexOf('-o')+1]),'review-context.json'),'utf8'));}catch{process.exit(2);}if(ctx.schema!==1||ctx.projectId!==42||ctx.mrIid!==7||ctx.title!==mr.title||ctx.description!==mr.description||ctx.baseSha!==mr.diff_refs.base_sha||ctx.startSha!==mr.diff_refs.start_sha||ctx.headSha!==mr.sha||prompt.includes(mr.description)||prompt.includes(mr.title)||!prompt.includes('使用alpha详细审查'))process.exit(3);if(fs.existsSync(${JSON.stringify(join(root, "change-mr"))})){let change=fs.readFileSync(${JSON.stringify(join(root, "change-mr"))},'utf8');fs.unlinkSync(${JSON.stringify(join(root, "change-mr"))});if(change==='draft')mr.draft=true;else mr.sha='f'.repeat(40);fs.writeFileSync(${JSON.stringify(mrFile)},JSON.stringify(mr));}if(fs.existsSync(${JSON.stringify(join(root, "change-skill"))})){fs.unlinkSync(${JSON.stringify(join(root, "change-skill"))});fs.writeFileSync(${JSON.stringify(join(skillDir, "SKILL.md"))},'changed skill');}if(fs.existsSync(${JSON.stringify(join(root, "change-prompt"))})){fs.unlinkSync(${JSON.stringify(join(root, "change-prompt"))});let f=${JSON.stringify(join(root, "rules.json"))},r=JSON.parse(fs.readFileSync(f));r.rules[0].prompt='更改的可信指令';fs.writeFileSync(f,JSON.stringify(r));}fs.writeFileSync(a[a.indexOf('-o')+1],fs.readFileSync(${JSON.stringify(reportFile)}));console.log(JSON.stringify({type:'turn.completed'}));});}`,
      { mode: 0o700 },
    );
    execFileSync(process.execPath, ["--check", codex]);
    const raw = {
      schema: 1,
      instanceKey: "work",
      instanceUrl: "https://gitlab.example.com",
      reviewerId: 8,
      hubUrl: "http://127.0.0.1:1234",
      sourceKeyPath: join(root, "key"),
      dataRoot: root,
      model: "model",
      codexPath: codex,
      glabPath: glab,
      projects: [
        {
          id: 42,
          projectPath: "team/app",
          rulesBranch: "main",
          cachePath: bare,
        },
      ],
    };
    const config = parseConfig(raw),
      main = trustedRules(config.projects[0]),
      catalog = await nativeBasis(codex, main.worktree, "使用alpha详细审查"),
      policy = policyHash(
        config,
        config.projects[0],
        hash(canonical({ prompt: "使用alpha详细审查", native: catalog.digest })),
        main.digest,
      );
    const req = {
      schema: 1,
      requestId: "a".repeat(64),
      projectId: 42,
      mrIid: 7,
      headSha: head,
      policyHash: policy,
      observation: 1,
      origin: "auto",
    };
    const dir = join(root, "gitlab", "requests", "42");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "7.json"), JSON.stringify(req));
    const rulesPath = join(root, "rules.json");
    writeFileSync(
      rulesPath,
      JSON.stringify({
        timezone: "Asia/Shanghai",
        sources: { gitlab: { name: "GitLab" } },
        agents: {
          review: {
            name: "Review",
            worker: "w1",
            use: "gitlab",
            command: ["review", "--config", join(root, "config.json")],
          },
        },
        channels: { chat: { name: "Chat", answerers: ["me"] } },
        rules: [
          {
            name: "gitlab-review-42",
            prompt: "使用alpha详细审查",
            when: { source: "gitlab", types: ["mr.review.42"] },
            to: "review",
            cwd: root,
            group: "gitlab",
            parallel: 1,
          },
        ],
      }),
    );
    process.env.AGENT_AUTOLOOP_HOME = join(root, "hub");
    process.env.AGENT_AUTOLOOP_RULES = rulesPath;
    process.env.AGENT_AUTOLOOP_PUBLIC_URL = "https://hub.test";
    const hub = await import("../host/runtime.ts");
    const { serve } = await import("../host/http.ts");
    const source = hub.addKey("source", "gitlab"),
      worker = hub.addKey("worker", "w1"),
      channel = hub.addKey("channel", "chat");
    server = serve(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const call = async (path: string, key: string, body?: unknown) => {
      const res = await fetch(baseUrl + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()) as any;
    };
    const event = {
      id: `gitlab:${req.requestId}`,
      type: "mr.review.42",
      subject: "work/42/7",
      summary: "审查 MR 当前版本",
      detail: JSON.stringify(req),
      link: "https://gitlab.example.com/team/repo/-/merge_requests/7",
    };
    assert.deepEqual((await call("/v1/events", source, event)).routed, ["gitlab-review-42"]);
    const job = (await call("/v1/work?claim=first&wait=0", worker)).job;
    assert.ok(job);
    await call(`/v1/runs/${job.run}/started`, job.token, {});
    const context = join(root, "context.json");
    writeFileSync(context, JSON.stringify(job.context));
    writeFileSync(join(root, "entry.json"), JSON.stringify({ job: { rule: job.rule } }));
    const file = join(root, "config.json");
    writeFileSync(file, JSON.stringify(raw));
    const originalRulesForRace = readFileSync(rulesPath, "utf8");
    writeFileSync(join(root, "change-prompt"), "1");
    const changedDuringRun = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "1",
          TEST_CHANGE_PROMPT: "1",
        },
      },
    );
    assert.equal(changedDuringRun.status, 1);
    assert.match(changedDuringRun.stderr, /审查配置已经变化/);
    assert.doesNotMatch(changedDuringRun.stdout, /确认发布审查评论/);
    writeFileSync(rulesPath, originalRulesForRace);
    const originalSkill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    writeFileSync(join(root, "change-skill"), "1");
    const changedSkillRun = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "1",
        },
      },
    );
    assert.equal(changedSkillRun.status, 1);
    assert.match(changedSkillRun.stderr, /审查配置已经变化/);
    assert.doesNotMatch(changedSkillRun.stdout, /确认发布审查评论/);
    writeFileSync(join(skillDir, "SKILL.md"), originalSkill);
    writeFileSync(join(root, "change-mr"), "1");
    const changedMrRun = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "1",
        },
      },
    );
    assert.equal(changedMrRun.status, 0, changedMrRun.stderr);
    assert.match(changedMrRun.stdout, /MR 版本或审查条件已变化/);
    assert.doesNotMatch(changedMrRun.stdout, /确认发布审查评论/);
    assert.equal(existsSync(join(root, "posts.log")), false);
    writeFileSync(mrFile, JSON.stringify(mr));
    rmSync(join(root, "gitlab", "reports"), { recursive: true, force: true });
    writeFileSync(join(root, "change-mr"), "draft");
    const changedEligibility = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "1",
        },
      },
    );
    assert.equal(changedEligibility.status, 0, changedEligibility.stderr);
    assert.match(changedEligibility.stdout, /MR 版本或审查条件已变化/);
    assert.doesNotMatch(changedEligibility.stdout, /确认发布审查评论/);
    writeFileSync(mrFile, JSON.stringify(mr));
    const child = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "1",
        },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = resultFrom(readMessage(child.stdout), {});
    assert.equal(result.problem, undefined, child.stdout);
    assert.equal(result.result.ask?.[0].options[0], "发布这份报告中的评论", child.stdout);
    assert.match(result.result.ask![0].text, /将发布[\s\S]*证据[\s\S]*建议/);
    await call(`/v1/runs/${job.run}/result`, job.token, result.result);
    const card = (await call("/v1/cards/next?wait=0", channel)).card;
    assert.ok(card);
    await call(`/v1/cards/${card.id}/delivered`, channel, { version: card.version, ref: "message-1" });
    await call(`/v1/cards/${card.id}/answer`, channel, { choice: 0, by: "me", ref: "message-1" });
    const next = (await call("/v1/work?claim=second&wait=0", worker)).job;
    assert.ok(next);
    await call(`/v1/runs/${next.run}/started`, next.token, {});
    const ask = result.result.ask![0];
    const firstManifest = loadArtifact(join(root, "gitlab"), "manifests", JSON.parse(ask.about!).manifestHash) as any;
    const firstReport = loadArtifact(join(root, "gitlab"), "reports", firstManifest.reportHash) as any;
    assert.equal(firstReport.trustedRules.commit, trustedCommit);
    assert.equal(firstReport.instructions.prompt, "使用alpha详细审查");
    assert.equal(firstReport.instructions.nativeCatalog[0].name, "alpha");
    assert.match(readFileSync(join(root, "gitlab", firstReport.audit, "prompt.txt"), "utf8"), /使用alpha详细审查/);
    const rawOutput = JSON.parse(readFileSync(join(root, "gitlab", firstReport.audit, "output.json"), "utf8"));
    assert.deepEqual(firstReport.findings, rawOutput.findings);
    assert.equal(rawOutput.complete, true);
    writeFileSync(context, JSON.stringify(next.context));
    const originalRules = readFileSync(rulesPath, "utf8"),
      changedPromptRules = JSON.parse(originalRules);
    changedPromptRules.rules[0].prompt = "使用alpha审查新策略";
    writeFileSync(rulesPath, JSON.stringify(changedPromptRules));
    const stalePrompt = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "2",
        },
      },
    );
    assert.equal(stalePrompt.status, 0, stalePrompt.stderr);
    assert.match(stalePrompt.stdout, /版本或策略已变化，未发布/);
    assert.equal(existsSync(join(root, "posts.log")), false);
    writeFileSync(rulesPath, originalRules);
    const changedRulesCommit = execFileSync(
      "git",
      ["--git-dir", bare, "commit-tree", tree(blob("changed trusted rule\n")), "-p", trustedCommit],
      {
        input: "update",
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.invalid",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
      },
    ).trim();
    execFileSync("git", ["--git-dir", bare, "update-ref", "refs/heads/main", changedRulesCommit]);
    const blocked = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "2",
        },
      },
    );
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout, /版本或策略已变化，未发布/);
    assert.equal(existsSync(join(root, "posts.log")), false);
    execFileSync("git", ["--git-dir", bare, "update-ref", "refs/heads/main", trustedCommit]);
    const resumed = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "2",
        },
      },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /审查评论已发布/);
    const resumedResult = resultFrom(readMessage(resumed.stdout), {});
    assert.equal(resumedResult.problem, undefined);
    await call(`/v1/runs/${next.run}/result`, next.token, resumedResult.result);
    const posts = readFileSync(join(root, "posts.log"), "utf8").trim().split("\n");
    assert.equal(posts.length, 1);
    const replay = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "3",
        },
      },
    );
    assert.match(replay.stdout, /审查评论已发布/);
    writeFileSync(
      context,
      JSON.stringify({
        ...next.context,
        events: [
          {
            id: `gitlab:${req.requestId}`,
            source: "gitlab",
            type: "mr.review.42",
            subject: "work/42/7",
            detail: JSON.stringify(req),
          },
        ],
      }),
    );
    const mixed = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "4",
          TEST_OLD: "1",
        },
      },
    );
    assert.match(mixed.stdout, /审查评论已发布/);
    const newerHead = tree(blob("newer\n"));
    const newerReq = { ...req, requestId: "f".repeat(64), headSha: newerHead, observation: 2 };
    writeFileSync(join(dir, "7.json"), JSON.stringify(newerReq));
    writeFileSync(
      mrFile,
      JSON.stringify({
        ...mr,
        sha: newerHead,
        head_pipeline: { sha: newerHead, status: "success" },
        diff_refs: { ...refs, head_sha: newerHead },
      }),
    );
    writeFileSync(
      versionFile,
      JSON.stringify({
        ...version,
        head_commit_sha: newerHead,
        diffs: [{ old_path: "a.txt", new_path: "a.txt", diff: "@@ -1 +1 @@\n-old\n+newer\n" }],
      }),
    );
    writeFileSync(
      context,
      JSON.stringify({
        ...next.context,
        events: [
          {
            id: `gitlab:${newerReq.requestId}`,
            source: "gitlab",
            type: "mr.review.42",
            subject: "work/42/7",
            detail: JSON.stringify(newerReq),
          },
        ],
      }),
    );
    const changed = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "5",
        },
      },
    );
    const changedResult = resultFrom(readMessage(changed.stdout), {});
    assert.equal(changedResult.problem, undefined, changed.stdout);
    assert.ok(
      changedResult.result.ask?.some((item) => item.title === "确认发布审查评论"),
      changed.stdout,
    );
    const manualReq = { ...newerReq, requestId: "1".repeat(64), observation: 3, origin: "manual" as const };
    const localBase = {
      ...manualReq,
      schema: 1 as const,
      instanceKey: "work",
      eligible: true,
      reviewerId: 8,
      overrides: ["draft"],
      reason: "确认",
    };
    saveRequest(join(root, "gitlab"), localBase);
    saveRequest(join(root, "gitlab"), {
      ...localBase,
      requestId: "2".repeat(64),
      observation: 4,
      origin: "auto",
      eligible: false,
    });
    writeFileSync(
      mrFile,
      JSON.stringify({
        ...mr,
        sha: newerHead,
        draft: true,
        head_pipeline: { sha: newerHead, status: "success" },
        diff_refs: { ...refs, head_sha: newerHead },
      }),
    );
    writeFileSync(
      context,
      JSON.stringify({
        events: [
          {
            id: `gitlab:${manualReq.requestId}`,
            source: "gitlab",
            type: "mr.review.42",
            subject: "work/42/7",
            detail: JSON.stringify(manualReq),
          },
        ],
        answers: [],
      }),
    );
    const manual = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "6",
        },
      },
    );
    const manualResult = resultFrom(readMessage(manual.stdout), {});
    assert.equal(manualResult.problem, undefined, manual.stdout);
    const manualAsk = manualResult.result.ask?.find((item) => item.title === "确认发布审查评论");
    assert.ok(manualAsk, manual.stdout);
    const manifestHash = JSON.parse(manualAsk.about!).manifestHash;
    const manifest = loadArtifact(join(root, "gitlab"), "manifests", manifestHash) as any;
    const storedReport = loadArtifact(join(root, "gitlab"), "reports", manifest.reportHash) as any;
    assert.equal(storedReport.requestId, manualReq.requestId);
    writeFileSync(
      context,
      JSON.stringify({
        events: [],
        answers: [
          {
            card: 2,
            title: manualAsk.title,
            options: manualAsk.options,
            choice: 0,
            text: null,
            about: manualAsk.about,
            by: null,
            at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const manualAnswer = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "7",
        },
      },
    );
    assert.match(manualAnswer.stdout, /审查评论已发布/);
    assert.equal(readFileSync(join(root, "posts.log"), "utf8").trim().split("\n").length, 2);
    const autoRaw = { ...raw, projects: [{ ...raw.projects[0], publication: "auto" }] };
    const autoConfig = parseConfig(autoRaw),
      autoPolicy = policyHash(
        autoConfig,
        autoConfig.projects[0],
        hash(
          canonical({
            prompt: "使用alpha详细审查",
            native: (await nativeBasis(codex, trustedRules(autoConfig.projects[0]).worktree, "使用alpha详细审查"))
              .digest,
          }),
        ),
        trustedRules(autoConfig.projects[0]).digest,
      );
    writeFileSync(file, JSON.stringify(autoRaw));
    const autoHead = tree(blob("auto\n")),
      autoReq = { ...req, requestId: "3".repeat(64), headSha: autoHead, policyHash: autoPolicy, observation: 5 };
    saveRequest(join(root, "gitlab"), {
      ...autoReq,
      schema: 1 as const,
      origin: "auto",
      instanceKey: "work",
      eligible: true,
    });
    writeFileSync(
      mrFile,
      JSON.stringify({
        ...mr,
        sha: autoHead,
        head_pipeline: { sha: autoHead, status: "success" },
        diff_refs: { ...refs, head_sha: autoHead },
      }),
    );
    writeFileSync(
      versionFile,
      JSON.stringify({
        ...version,
        head_commit_sha: autoHead,
        diffs: [{ old_path: "a.txt", new_path: "a.txt", diff: "@@ -1 +1 @@\n-old\n+auto\n" }],
      }),
    );
    writeFileSync(
      context,
      JSON.stringify({
        events: [
          {
            id: `gitlab:${autoReq.requestId}`,
            source: "gitlab",
            type: "mr.review.42",
            subject: "work/42/7",
            detail: JSON.stringify(autoReq),
          },
        ],
        answers: [],
      }),
    );
    const automatic = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "8",
        },
      },
    );
    assert.match(automatic.stdout, /审查评论已发布/, automatic.stderr);
    assert.equal(readFileSync(join(root, "posts.log"), "utf8").trim().split("\n").length, 3);
    const compareHead = tree(blob("compare\n")),
      compareReq = { ...autoReq, requestId: "4".repeat(64), headSha: compareHead, observation: 6 };
    saveRequest(join(root, "gitlab"), {
      ...compareReq,
      schema: 1 as const,
      origin: "auto",
      instanceKey: "work",
      eligible: true,
    });
    writeFileSync(
      mrFile,
      JSON.stringify({
        ...mr,
        sha: compareHead,
        head_pipeline: { sha: compareHead, status: "success" },
        diff_refs: { ...refs, head_sha: compareHead },
      }),
    );
    writeFileSync(
      versionFile,
      JSON.stringify({
        ...version,
        head_commit_sha: compareHead,
        diffs: [{ old_path: "a.txt", new_path: "a.txt", diff: "@@ -1 +1 @@\n-old\n+compare\n" }],
      }),
    );
    writeFileSync(
      context,
      JSON.stringify({
        events: [
          {
            id: `gitlab:${compareReq.requestId}`,
            source: "gitlab",
            type: "mr.review.42",
            subject: "work/42/7",
            detail: JSON.stringify(compareReq),
          },
        ],
        answers: [],
      }),
    );
    const compare = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "9",
          TEST_OLD: "1",
        },
      },
    );
    const compareResult = resultFrom(readMessage(compare.stdout), {});
    assert.equal(compareResult.problem, undefined, compare.stdout);
    assert.ok(
      compareResult.result.ask?.some((item) => item.title === "确认发布审查评论"),
      compare.stdout,
    );
    assert.equal(readFileSync(join(root, "posts.log"), "utf8").trim().split("\n").length, 3);
    const comparisonAsk = compareResult.result.ask!.find((item) => item.title === "确认发布审查评论")!;
    const comparisonEvent = {
      id: `gitlab:${compareReq.requestId}`,
      source: "gitlab",
      type: "mr.review.42",
      subject: "work/42/7",
      detail: JSON.stringify(compareReq),
    };
    writeFileSync(
      context,
      JSON.stringify({
        events: [comparisonEvent],
        answers: [
          {
            card: 55,
            title: comparisonAsk.title,
            options: comparisonAsk.options,
            choice: 0,
            text: null,
            about: comparisonAsk.about,
            by: null,
            at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const unknown = spawnSync(
      process.execPath,
      [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          AGENT_AUTOLOOP_HOME: root,
          AGENT_AUTOLOOP_CONTEXT: context,
          AGENT_AUTOLOOP_RUN: "11",
          TEST_OLD: "1",
          TEST_POST_FAIL: "1",
        },
      },
    );
    const unknownReceipt = resultFrom(readMessage(unknown.stdout), {});
    assert.equal(unknown.status, 0, unknown.stderr);
    assert.match(unknownReceipt.result.summary!, /发送结果未确认/);
    assert.doesNotMatch(unknownReceipt.result.summary!, /已发布/);
    const raceHead = tree(blob("race\n")),
      raceReq = { ...autoReq, requestId: "5".repeat(64), headSha: raceHead, observation: 7 };
    saveRequest(join(root, "gitlab"), {
      ...raceReq,
      schema: 1 as const,
      origin: "auto",
      instanceKey: "work",
      eligible: true,
    });
    writeFileSync(
      mrFile,
      JSON.stringify({
        ...mr,
        sha: raceHead,
        head_pipeline: { sha: raceHead, status: "success" },
        diff_refs: { ...refs, head_sha: raceHead },
      }),
    );
    writeFileSync(
      versionFile,
      JSON.stringify({
        ...version,
        head_commit_sha: raceHead,
        diffs: [{ old_path: "a.txt", new_path: "a.txt", diff: "@@ -1 +1 @@\n-old\n+race\n" }],
      }),
    );
    writeFileSync(
      reportFile,
      JSON.stringify({ ...report, findings: [...report.findings, { ...report.findings[0], title: "第二个问题" }] }),
    );
    writeFileSync(
      context,
      JSON.stringify({
        events: [
          {
            id: `gitlab:${raceReq.requestId}`,
            source: "gitlab",
            type: "mr.review.42",
            subject: "work/42/7",
            detail: JSON.stringify(raceReq),
          },
        ],
        answers: [],
      }),
    );
    const race = spawnSync(process.execPath, [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        AGENT_AUTOLOOP_HOME: root,
        AGENT_AUTOLOOP_CONTEXT: context,
        AGENT_AUTOLOOP_RUN: "10",
        TEST_CHANGE_RULES: changedRulesCommit,
      },
    });
    assert.equal(race.status, 1);
    assert.match(race.stderr, /评论已发到旧版本|版本或审查策略已变化|审查配置已经变化/);
    assert.equal(
      readFileSync(join(root, "posts.log"), "utf8").trim().split("\n").length,
      4,
      "only first of two items may post",
    );
    const severityRaw = { ...raw, projects: [{ ...raw.projects[0], publication: "severity" }] };
    writeFileSync(file, JSON.stringify(severityRaw));
    const severityConfig = parseConfig(severityRaw);
    const severityTrusted = trustedRules(severityConfig.projects[0]);
    const severityNative = await nativeBasis(codex, severityTrusted.worktree, "使用alpha详细审查");
    const severityPolicy = policyHash(
      severityConfig,
      severityConfig.projects[0],
      hash(canonical({ prompt: "使用alpha详细审查", native: severityNative.digest })),
      severityTrusted.digest,
    );
    let observation = 20;
    for (const scenario of ["zero", "critical", "mixed", "ordinary", "p3"] as const) {
      const scenarioHead = tree(blob(`${scenario}\n`));
      const scenarioRequest = {
        ...req,
        requestId: observation.toString(16).padStart(64, "0"),
        headSha: scenarioHead,
        policyHash: severityPolicy,
        observation: observation++,
      };
      saveRequest(join(root, "gitlab"), {
        ...scenarioRequest,
        schema: 1 as const,
        origin: "auto" as const,
        instanceKey: "work",
        eligible: true,
      });
      writeFileSync(
        mrFile,
        JSON.stringify({
          ...mr,
          sha: scenarioHead,
          head_pipeline: { sha: scenarioHead, status: "success" },
          diff_refs: { ...refs, head_sha: scenarioHead },
        }),
      );
      writeFileSync(
        versionFile,
        JSON.stringify({
          ...version,
          head_commit_sha: scenarioHead,
          diffs: [{ old_path: "a.txt", new_path: "a.txt", diff: `@@ -1 +1 @@\n-old\n+${scenario}\n` }],
        }),
      );
      const p0 = {
        ...report.findings[0],
        severity: "P0",
        title: `严重-${scenario}`,
        line: scenario === "ordinary" ? null : 1,
      };
      const p2 = { ...report.findings[0], title: `普通-${scenario}` };
      writeFileSync(
        reportFile,
        JSON.stringify({
          ...report,
          findings:
            scenario === "zero"
              ? []
              : scenario === "mixed"
                ? [p0, p2]
                : scenario === "p3"
                  ? [{ ...p2, severity: "P3" }]
                  : [p0],
        }),
      );
      writeFileSync(
        context,
        JSON.stringify({
          events: [
            {
              id: `gitlab:${scenarioRequest.requestId}`,
              source: "gitlab",
              type: "mr.review.42",
              subject: "work/42/7",
              detail: JSON.stringify(scenarioRequest),
            },
          ],
          answers: [],
        }),
      );
      const beforePosts = readFileSync(join(root, "posts.log"), "utf8").trim().split("\n").length;
      const execution = spawnSync(
        process.execPath,
        [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: root,
            AGENT_AUTOLOOP_HOME: root,
            AGENT_AUTOLOOP_CONTEXT: context,
            AGENT_AUTOLOOP_RUN: String(observation),
            TEST_OLD: "1",
          },
        },
      );
      assert.equal(execution.status, 0, execution.stderr);
      const parsed = resultFrom(readMessage(execution.stdout), {}).result;
      const afterPosts = readFileSync(join(root, "posts.log"), "utf8").trim().split("\n");
      assert.equal(afterPosts.length - beforePosts, scenario === "zero" || scenario === "p3" ? 0 : 1);
      if (scenario === "zero") assert.match(parsed.notice?.[0].text ?? "", /人工/);
      if (scenario === "p3") {
        assert.match(parsed.notice?.[0].text ?? "", /P3/);
        assert.equal(parsed.ask?.length ?? 0, 0);
      }
      if (scenario === "critical" || scenario === "ordinary") {
        assert.equal(parsed.ask?.length ?? 0, 0);
        assert.equal(parsed.notice?.length ?? 0, 0);
      }
      if (scenario === "ordinary") assert.equal(JSON.parse(afterPosts.at(-1)!).position, undefined);
      if (scenario === "mixed") {
        assert.equal(parsed.ask?.length, 1);
        const onlyP2 = loadArtifact(
          join(root, "gitlab"),
          "manifests",
          JSON.parse(parsed.ask![0].about!).manifestHash,
        ) as any;
        assert.equal(onlyP2.items.length, 1);
        assert.match(onlyP2.items[0].body, /^\[P2\]/);
        assert.doesNotMatch(parsed.ask![0].text, /严重-mixed/);
        writeFileSync(
          context,
          JSON.stringify({
            events: [],
            answers: [
              {
                card: 300,
                title: parsed.ask![0].title,
                options: parsed.ask![0].options,
                choice: 0,
                text: null,
                about: parsed.ask![0].about,
                by: null,
                at: "2026-01-01T00:00:00Z",
              },
            ],
          }),
        );
        const approved = spawnSync(
          process.execPath,
          [resolve("plugins/gitlab/run.ts"), "--config", file, "--model", "model"],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: root,
              AGENT_AUTOLOOP_HOME: root,
              AGENT_AUTOLOOP_CONTEXT: context,
              AGENT_AUTOLOOP_RUN: "40",
            },
          },
        );
        assert.equal(approved.status, 0, approved.stderr);
        const approvedPosts = readFileSync(join(root, "posts.log"), "utf8").trim().split("\n");
        assert.equal(approvedPosts.length, afterPosts.length + 1);
        assert.match(JSON.parse(approvedPosts.at(-1)!).body, /^\[P2\]/);
      }
    }
  } finally {
    if (server) {
      server.closeAllConnections();
      server.close();
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
