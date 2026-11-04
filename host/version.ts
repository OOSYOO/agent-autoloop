// Which code this is: the version in package.json and the commit it's at.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");

/** What was deployed, or the checkout's commit. Git says: after a gc a branch's ref is no longer a file of its own. */
export function commitOf(root = ROOT) {
  if (process.env.AGENT_AUTOLOOP_COMMIT) return process.env.AGENT_AUTOLOOP_COMMIT;
  try {
    const manifestFile = path.join(root, "local-install.json");
    if (existsSync(manifestFile)) {
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      if (manifest.kind === "agent-autoloop-local-install" && /^[a-f0-9]{64}$/.test(manifest.contentSha256))
        return `local-${manifest.contentSha256.slice(0, 12)}`;
    }
    // Only a checkout has its own .git entry; unpacked copies must not inherit a parent repository's commit.
    if (!existsSync(path.join(root, ".git"))) return "dev";
    const args = ["-C", root, "rev-parse", "HEAD"];
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "dev";
  }
}

export function versionLine() {
  const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const revision = commitOf();
  return `agent-autoloop ${version}（${revision.startsWith("local-") ? `本地构建 ${revision.slice(6)}` : `提交 ${revision.slice(0, 12)}`}）`;
}
