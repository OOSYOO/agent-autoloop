// Failure modes: GitLab requests choose another host, lose pages or put write content in shell arguments.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitLab } from "../plugins/gitlab/api.ts";
test("uses explicit host and paginates through glab", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-api-"));
  try {
    const fake = join(root, "glab");
    writeFileSync(
      fake,
      `#!/usr/bin/env node\nconst a=process.argv.slice(2); if(!a.includes('--hostname') || !a.includes('gitlab.example.com') || a.includes('--paginate')) process.exit(1); const second=a[1].includes('page=2'); process.stdout.write('HTTP/1.1 200 OK\\r\\nX-Next-Page: '+(second?'':'2')+'\\r\\n\\r\\n'+JSON.stringify([{id:second?2:1}]));\n`,
      { mode: 0o700 },
    );
    const api = new GitLab(fake, "https://gitlab.example.com");
    assert.deepEqual(await api.list("projects/1/merge_requests"), [{ id: 1 }, { id: 2 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST carries body on stdin and requires HTTP 201", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-api-post-"));
  try {
    const fake = join(root, "glab");
    writeFileSync(
      fake,
      `#!/usr/bin/env node\nlet s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{let a=process.argv.slice(2);if(!a.includes('--input')||!a.includes('-')||!a.includes('Content-Type: application/json')||a.includes('secret-body'))process.exit(2);process.stdout.write('HTTP/1.1 201 Created\\r\\nContent-Type: application/json\\r\\n\\r\\n'+JSON.stringify({id:'d',notes:[{id:3}],received:JSON.parse(s).body}));});`,
      { mode: 0o700 },
    );
    const api = new GitLab(fake, "https://gitlab.example.com");
    assert.equal(
      ((await api.post("projects/1/merge_requests/2/discussions", { body: "secret-body" })) as any).received,
      "secret-body",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("429 reads honor retry-after before repeating", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitlab-api-rate-"));
  try {
    const fake = join(root, "glab"),
      count = join(root, "count");
    writeFileSync(
      fake,
      `#!/usr/bin/env node\nconst fs=require('fs'),p=${JSON.stringify(count)};if(!fs.existsSync(p)){fs.writeFileSync(p,'1');process.stdout.write('HTTP/1.1 429 Too Many Requests\\r\\nRetry-After: 0\\r\\n\\r\\n{}');process.exitCode=1;}else process.stdout.write('HTTP/1.1 200 OK\\r\\n\\r\\n{\"id\":8}');`,
      { mode: 0o700 },
    );
    const api = new GitLab(fake, "https://gitlab.example.com");
    assert.deepEqual(await api.get("user"), { id: 8 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("temporary GitLab server failure is distinguishable from a business block", async () => {
  const { TemporaryError } = await import("../plugins/gitlab/api.ts");
  assert.equal(typeof TemporaryError, "function");
  const root = mkdtempSync(join(tmpdir(), "gitlab-api-temp-"));
  try {
    const fake = join(root, "glab");
    writeFileSync(
      fake,
      `#!/usr/bin/env node\nprocess.stdout.write('HTTP/1.1 503 Service Unavailable\\r\\n\\r\\n{}');process.exitCode=1;`,
      { mode: 0o700 },
    );
    const api = new GitLab(fake, "https://gitlab.example.com");
    await assert.rejects(api.get("user"), TemporaryError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
