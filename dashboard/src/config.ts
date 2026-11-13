import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
export function loadConfig(home = process.env.AGENT_AUTOLOOP_HOME || join(homedir(), ".agent-autoloop")) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  } catch {
    throw new Error("无法读取 config.json，请先运行 agent-autoloop init");
  }
  let url: URL;
  try {
    url = new URL(config?.url);
  } catch {
    throw new Error("中台地址不合法");
  }
  if (
    !LOOPBACK_HOSTNAMES.has(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("中台地址必须是无附加参数的本机回环 HTTP/HTTPS 地址");
  if (typeof config.owner !== "string" || !config.owner.trim()) throw new Error("缺少本人的密钥");
  return { hubUrl: url, owner: config.owner };
}
