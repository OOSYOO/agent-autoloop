import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline";
import { canonical, hash } from "./storage.ts";

async function inspect(program: string, cwd: string) {
  const child = spawn(program, ["app-server", "--listen", "stdio://"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  let config: any;
  return await new Promise<{ config: any; skills: any[]; errors: unknown[] }>((resolveResult, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Codex 原生目录读取超时"));
    }, 20000);
    const fail = (error: Error) => {
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    child.on("error", fail);
    child.on("close", (code) => {
      if (code !== null) fail(new Error("Codex 原生目录读取失败"));
    });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.error) {
        fail(new Error("Codex 原生配置或 Skill 目录读取失败"));
        return;
      }
      if (message.id === 1) {
        child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        child.stdin.write(JSON.stringify({ id: 2, method: "config/read", params: { cwd } }) + "\n");
      }
      if (message.id === 2) {
        config = message.result?.config;
        child.stdin.write(
          JSON.stringify({ id: 3, method: "skills/list", params: { cwds: [cwd], forceReload: true } }) + "\n",
        );
      }
      if (message.id === 3) {
        const entries = message.result?.data;
        if (!config || !Array.isArray(entries) || entries.length !== 1 || !Array.isArray(entries[0].skills)) {
          fail(new Error("Codex Skill 目录不完整"));
          return;
        }
        clearTimeout(timer);
        child.kill();
        resolveResult({ config, skills: entries[0].skills, errors: entries[0].errors ?? [] });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.write(
      JSON.stringify({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "agent-autoloop", version: "1" } },
      }) + "\n",
    );
  });
}

export async function nativeBasis(program: string, cwd: string, prompt: string) {
  const result = await inspect(program, cwd),
    config = result.config;
  // The native catalog chooses Skills; file hashes only invalidate stale results.
  const skills = result.skills
    .filter((s: any) => s.enabled === true)
    .map((s: any) => ({ name: s.name, path: s.path, scope: s.scope, pluginId: s.pluginId ?? null }))
    .sort((a: any, b: any) => canonical(a).localeCompare(canonical(b), "en"));
  // This selects invalidation evidence only; Codex still discovers and loads Skills natively.
  const mentioned = skills.filter((skill) => {
    const names = [skill.name, skill.name.split(":").at(-1)];
    return names.some((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`, "i").test(prompt);
    });
  });
  const reviewConfig = Object.fromEntries(
    [
      "instructions",
      "developer_instructions",
      "model_instructions_file",
      "project_doc_max_bytes",
      "project_doc_fallback_filenames",
      "project_root_markers",
      "model_provider",
    ].map((key) => [key, config[key] ?? null]),
  );
  reviewConfig.provider = config.model_providers?.[config.model_provider] ?? null;
  const fileHashes: { path: string; hash: string }[] = [];
  const seen = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    try {
      const real = realpathSync(path);
      if (seen.has(real)) return;
      seen.add(real);
      const stat = lstatSync(real);
      if (stat.isDirectory()) {
        for (const name of readdirSync(real).sort()) await visit(join(real, name));
      } else if (stat.isFile()) {
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(real)) digest.update(chunk);
        fileHashes.push({ path: real, hash: digest.digest("hex") });
      } else fileHashes.push({ path: real, hash: "non-regular" });
    } catch (error) {
      // Catalog entries can include unrelated optional assets; their availability is evidence, not admission.
      fileHashes.push({ path, hash: `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}` });
    }
  };
  for (const skill of mentioned) {
    if (!["repo", "user", "system", "admin"].includes(skill.scope) || typeof skill.path !== "string")
      throw new Error("Skill 目录信息无效");
    await visit(dirname(skill.path));
  }
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const globals = new Set([join(codexHome, "AGENTS.md"), join(codexHome, "AGENTS.override.md")]);
  for (let current = resolve(cwd); ; current = dirname(current)) {
    globals.add(join(current, "AGENTS.md"));
    globals.add(join(current, "AGENTS.override.md"));
    if (dirname(current) === current) break;
  }
  for (const file of globals) if (existsSync(file) && !file.startsWith(resolve(cwd) + "/")) await visit(file);
  if (typeof config.model_instructions_file === "string") await visit(resolve(cwd, config.model_instructions_file));
  fileHashes.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return {
    digest: hash(canonical({ config: reviewConfig, skills: mentioned, fileHashes })),
    skills,
    files: fileHashes,
  };
}
