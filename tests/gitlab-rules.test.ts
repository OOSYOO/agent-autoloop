// Failure modes: untrusted MR rule content or a stale remote branch grants changed review policy.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("project identity binds the GitLab metadata to the configured cache origin", async () => {
  const { verifyProjectRemote } = await import("../plugins/gitlab/trusted-rules.ts");
  const root = mkdtempSync(join(tmpdir(), "gitlab-origin-"));
  try {
    const cache = join(root, "cache.git");
    execFileSync("git", ["init", "--bare", cache]);
    execFileSync("git", ["--git-dir", cache, "remote", "add", "origin", "git@example.com:team/app.git"]);
    const project = { id: 42, projectPath: "team/app", cachePath: cache };
    const gl = {
      get: async () => ({
        id: 42,
        path_with_namespace: "team/app",
        ssh_url_to_repo: "git@example.com:team/app.git",
        http_url_to_repo: "https://example.com/team/app.git",
      }),
    };
    await verifyProjectRemote(gl, project);
    await assert.rejects(
      verifyProjectRemote(
        { get: async () => ({ ...(await gl.get()), ssh_url_to_repo: "git@example.com:team/other.git" }) },
        project,
      ),
    );
    await assert.rejects(
      verifyProjectRemote({ get: async () => ({ ...(await gl.get()), path_with_namespace: "team/other" }) }, project),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
