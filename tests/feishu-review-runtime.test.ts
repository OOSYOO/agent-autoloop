// Failure modes: a lost delivery advances the cursor; confirmation bypasses draft restrictions; repeated requests dispatch the same head twice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";

test("fake CLI scan, confirmation and GitLab admission survive replay and retain reviewer-only authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-review-"));
  const events = new Map<string, any>();
  let rejectPost = true;
  let loseReceipt = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer secret");
    let text = "";
    for await (const chunk of req) text += chunk;
    const event = JSON.parse(text);
    if (rejectPost) {
      res.writeHead(503);
      res.end();
      return;
    }
    const duplicate = events.has(event.id);
    events.set(event.id, event);
    if (loseReceipt) {
      loseReceipt = false;
      res.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ event: events.size, duplicate, routed: ["rule"] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const bare = join(root, "cache.git");
    execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
    execFileSync("git", ["--git-dir", bare, "remote", "add", "origin", "https://gitlab.example.com/team/repo.git"]);
    const glab = join(root, "glab.cjs"),
      lark = join(root, "lark.cjs");
    const mrFile = join(root, "mr.json");
    const sha = "a".repeat(40);
    const mr = { iid: 7, state: "opened", draft: false, sha, reviewers: [], head_pipeline: { sha, status: "failed" } };
    writeFileSync(mrFile, JSON.stringify(mr));
    writeFileSync(
      glab,
      `#!/usr/bin/env node\nconst fs=require('fs');const p=process.argv[3];console.log(JSON.stringify(p==='user'?{id:8}:p==='projects/42'?{id:42,path_with_namespace:'team/repo',http_url_to_repo:'https://gitlab.example.com/team/repo.git'}:JSON.parse(fs.readFileSync(${JSON.stringify(mrFile)}))));`,
      { mode: 0o700 },
    );
    const message = {
      message_id: "om_1",
      chat_id: "oc_1",
      chat_type: "p2p",
      sender: { id: "ou_peer", sender_type: "user" },
      content: "https://gitlab.example.com/team/repo/-/merge_requests/7",
      create_time: String(Date.now()),
    };
    const messagesFile = join(root, "messages.json");
    writeFileSync(messagesFile, JSON.stringify([message]));
    writeFileSync(
      lark,
      `#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a.some(v=>/[.]\\d{3}Z$/.test(v)))process.exit(7);if(a[0]==='auth')console.log(JSON.stringify({identities:{user:{openId:'ou_me'}}}));else {if(!a.includes('user')||a.includes('--as')&&a[a.indexOf('--as')+1]!=='user')process.exit(4);console.log(JSON.stringify({ok:true,data:{messages:a.includes('group')?[]:JSON.parse(require('fs').readFileSync(${JSON.stringify(messagesFile)})),has_more:false}}))}`,
      { mode: 0o700 },
    );
    const glConfig = join(root, "gitlab.json"),
      config = join(root, "feishu.json"),
      contextFile = join(root, "context.json");
    writeFileSync(join(root, "key"), "secret", { mode: 0o600 });
    writeFileSync(
      glConfig,
      JSON.stringify({
        schema: 1,
        instanceKey: "work",
        instanceUrl: "https://gitlab.example.com",
        reviewerId: 8,
        hubUrl: `http://127.0.0.1:${(server.address() as any).port}`,
        sourceKeyPath: join(root, "key"),
        dataRoot: root,
        model: "test",
        codexPath: process.execPath,
        glabPath: glab,
        projects: [{ id: 42, projectPath: "team/repo", cachePath: bare }],
      }),
    );
    writeFileSync(config, JSON.stringify({ user: "ou_me", gitlabConfig: glConfig, lark, route: "app" }));
    writeFileSync(
      join(root, "rules.json"),
      JSON.stringify({
        agents: { review: { use: "gitlab", command: ["review", "--config", glConfig] } },
        rules: [
          { name: "review", when: { source: "gitlab", types: ["mr.review.42"] }, to: "review", prompt: "可信审查指令" },
        ],
      }),
    );
    const run = (action: string, context = { events: [] as any[], answers: [] as any[] }) => {
      writeFileSync(contextFile, JSON.stringify(context));
      return new Promise<{ code: number; stdout: string; stderr: string }>((r) =>
        execFile(
          process.execPath,
          [resolve("plugins/feishu/review-runtime.ts"), action, "--config", config],
          { env: { ...process.env, AGENT_AUTOLOOP_HOME: root, AGENT_AUTOLOOP_CONTEXT: contextFile }, encoding: "utf8" },
          (error, stdout, stderr) => r({ code: error ? 1 : 0, stdout, stderr }),
        ),
      );
    };
    assert.equal((await run("scan")).code, 1);
    const cursor = readFileSync(join(root, "feishu-review/work/ou_me/cursor.json"), "utf8");
    rejectPost = false;
    assert.equal((await run("scan")).code, 0);
    assert.notEqual(readFileSync(join(root, "feishu-review/work/ou_me/cursor.json"), "utf8"), cursor);
    assert.equal((await run("scan")).code, 0);
    assert.equal(events.size, 1);
    const event = [...events.values()][0];
    assert.equal(event.type, "feishu.review.request.app");
    const context = { events: [{ ...event, source: "gitlab" }], answers: [] as any[] };
    const wrongRoute = await run("review", {
      events: [{ ...event, source: "gitlab", type: "feishu.review.request.other" }],
      answers: [],
    });
    assert.match(wrongRoute.stdout, /"ask":\[\]/);
    const first = await run("review", context);
    assert.equal(first.code, 0, first.stderr);
    const result = JSON.parse(first.stdout.split("```agent-autoloop\n")[1].split("\n```")[0]);
    assert.equal(result.ask.length, 1);
    assert.equal(events.size, 1);
    const confirmed = { events: [], answers: [{ about: result.ask[0].about, choice: 0 }] };
    writeFileSync(mrFile, JSON.stringify({ ...mr, draft: true }));
    assert.equal((await run("review", confirmed)).code, 1);
    assert.equal(events.size, 1);
    writeFileSync(mrFile, JSON.stringify(mr));
    const accepted = await run("review", confirmed);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(events.size, 2);
    assert.equal((await run("review", confirmed)).code, 0);
    assert.equal(events.size, 2);
    const record = JSON.parse(readFileSync(join(root, "gitlab/requests/42/7.json"), "utf8"));
    assert.deepEqual(record.overrides, ["reviewer"]);
    assert.match(record.reason, /om_1/);
    assert.equal(record.delivered, true);
    writeFileSync(
      messagesFile,
      JSON.stringify([{ ...message, message_id: "om_2", content: `帮忙 review ${message.content}` }]),
    );
    assert.equal((await run("scan")).code, 0);
    const explicit = [...events.values()].find((e) => e.type === "feishu.review.request.app" && e.id !== event.id);
    const directContext = { events: [{ ...explicit, source: "gitlab" }], answers: [] };
    const direct = await run("review", directContext);
    assert.equal(direct.code, 0, direct.stderr);
    assert.match(direct.stdout, /"ask":\[\]/);
    assert.equal(events.size, 3);
    const nextSha = "b".repeat(40);
    // A stale pipeline does not block the new head.
    writeFileSync(mrFile, JSON.stringify({ ...mr, sha: nextSha }));
    loseReceipt = true;
    assert.equal((await run("review", directContext)).code, 1);
    assert.equal(events.size, 4);
    // A different message must recover the pending head instead of minting another request ID.
    assert.equal((await run("review", confirmed)).code, 0);
    assert.equal(events.size, 4);
    writeFileSync(lark, '#!/usr/bin/env node\nconsole.log(JSON.stringify({identities:{user:{openId:"ou_other"}}}));', {
      mode: 0o700,
    });
    const blocked = await run("scan");
    assert.equal(blocked.code, 0);
    assert.match(blocked.stdout, /飞书消息读取需要处理/);
    writeFileSync(lark, "#!/usr/bin/env node\nprocess.exit(9);", { mode: 0o700 });
    const waiting = await run("scan", { events: [], answers: [], open: [{ title: "飞书消息读取需要处理" }] } as any);
    assert.equal(waiting.code, 0, waiting.stderr);
    assert.match(waiting.stdout, /"ask":\[\]/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
