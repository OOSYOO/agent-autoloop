import { spawn } from "node:child_process";
export class TemporaryError extends Error {}
export class GitLabWriteError extends Error {
  readonly status: number | null;
  constructor(status: number | null) {
    super("GitLab 写入结果未知或未接受");
    this.status = status;
  }
}
export class GitLab {
  private readonly program: string;
  private readonly origin: string;
  constructor(program: string, origin: string) {
    this.program = program;
    this.origin = origin;
  }
  private async call(path: string): Promise<{ body: unknown; headers: string }> {
    if (!/^[a-zA-Z0-9_/?=&.%+-]+$/.test(path) || path.startsWith("/")) throw new Error("接口路径无效");
    const url = new URL(this.origin);
    const args = ["api", path, "--hostname", url.host, "--include"];
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(this.program, args, { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.length > 32 * 1024 * 1024) child.kill();
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
    const match = /^HTTP\/\S+\s+(\d{3})[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n([\s\S]*)$/.exec(result.output);
    if (match?.[1] === "429") {
      const retry = /^retry-after:\s*(.+)\s*$/im.exec(match[2])?.[1]?.trim();
      if (!retry) throw new Error("GitLab 限流但未提供等待时间");
      const delay = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      if (!Number.isFinite(delay) || delay < 0 || delay > 2147483647) throw new Error("GitLab 限流等待时间无效");
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.call(path);
    }
    if ((match && Number(match[1]) >= 500) || (!match && result.code !== 0))
      throw new TemporaryError("GitLab 暂时不可用");
    if (result.code !== 0 || (match && match[1] !== "200")) throw new Error(`GitLab 读取失败（退出码 ${result.code}）`);
    try {
      return { body: JSON.parse(match ? match[3] : result.output), headers: match?.[2] ?? "" };
    } catch {
      throw new Error("GitLab 返回的数据无效");
    }
  }
  async get(path: string): Promise<unknown> {
    return (await this.call(path)).body;
  }
  async list(path: string): Promise<unknown[]> {
    const url = new URL(`https://local.invalid/${path}`);
    if (url.origin !== "https://local.invalid") throw new Error("接口路径无效");
    if (!url.searchParams.has("per_page")) url.searchParams.set("per_page", "100");
    const seen = new Set<string>();
    const result: unknown[] = [];
    let page = "1";
    while (page) {
      if (!/^[1-9][0-9]*$/.test(page) || seen.has(page)) throw new Error("GitLab 分页无效");
      seen.add(page);
      url.searchParams.set("page", page);
      const response = await this.call(url.pathname.slice(1) + url.search);
      if (!Array.isArray(response.body)) throw new Error("GitLab 列表无效");
      result.push(...response.body);
      page = /^x-next-page:\s*(\d*)\s*$/im.exec(response.headers)?.[1] ?? "";
    }
    return result;
  }
  async post(path: string, body: unknown): Promise<unknown> {
    if (!/^[a-zA-Z0-9_/.%-]+$/.test(path) || path.startsWith("/")) throw new Error("接口路径无效");
    const args = [
      "api",
      path,
      "--hostname",
      new URL(this.origin).host,
      "--method",
      "POST",
      "--include",
      "--input",
      "-",
      "--header",
      "Content-Type: application/json",
    ];
    return await new Promise((resolve, reject) => {
      const child = spawn(this.program, args, { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.length > 8 * 1024 * 1024) child.kill();
      });
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", (code) => {
        const match = /^HTTP\/\S+\s+(\d{3})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(output);
        if (code !== 0 || !match || match[1] !== "201") {
          reject(new GitLabWriteError(match ? Number(match[1]) : null));
          return;
        }
        try {
          resolve(JSON.parse(match[2]));
        } catch {
          reject(new GitLabWriteError(201));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(body));
    });
  }
}
