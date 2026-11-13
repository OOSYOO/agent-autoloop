import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LOOPBACK_HOSTNAMES } from "./config.ts";
import { HubError, type createHubClient } from "./hub-client.ts";
const routes = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/app-controller.js": ["app-controller.js", "text/javascript"],
  "/view-model.js": ["view-model.js", "text/javascript"],
  "/api.js": ["api.js", "text/javascript"],
  "/style.css": ["style.css", "text/css"],
};
export function createDashboardServer({
  hubClient,
  publicDir = join(import.meta.dirname, "../public"),
}: {
  hubClient: ReturnType<typeof createHubClient>;
  publicDir?: string;
}) {
  const instance = randomUUID();
  const resources = new Map(
    Object.entries(routes).map(([path, [file, type]]) => [
      path,
      { content: readFileSync(join(publicDir, file)), type },
    ]),
  );
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  };
  const server = createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    );
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    void (async () => {
      const host = req.headers.host || "";
      let parsed: URL;
      try {
        parsed = new URL(`http://${host}`);
      } catch {
        throw new HubError(403, "LOCAL_ACCESS_DENIED", "请从本机地址打开");
      }
      if (
        !LOOPBACK_HOSTNAMES.has(parsed.hostname) ||
        parsed.host !== host ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash ||
        Number(parsed.port || 80) !== req.socket.localPort
      )
        throw new HubError(403, "LOCAL_ACCESS_DENIED", "请从本机地址打开");
      const raw = req.url || "/";
      if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("?") || raw.includes("#"))
        throw new HubError(400, "INVALID_REQUEST", "不支持此请求地址或参数");
      if (raw === "/api/state" && req.method === "GET") {
        res.setHeader("x-dashboard-instance", instance);
        return json(res, 200, await hubClient.state());
      }
      const match = /^\/api\/cards\/([1-9]\d*)\/answer$/.exec(raw);
      if (match && req.method === "POST") {
        if (
          req.headers.origin !== `http://${host}` ||
          req.headers["x-dashboard-action"] !== "answer" ||
          (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") ||
          req.headers.authorization
        )
          throw new HubError(403, "LOCAL_ACCESS_DENIED", "仅允许本页提交");
        if (req.headers["x-dashboard-instance"] !== instance)
          throw new HubError(409, "PAGE_RELOAD_REQUIRED", "看板已重启，请重新加载页面后操作");
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || ""))
          throw new HubError(415, "UNSUPPORTED_MEDIA_TYPE", "只接受 JSON");
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id)) throw new HubError(400, "INVALID_REQUEST", "卡片编号不正确");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) {
            res.shouldKeepAlive = false;
            throw new HubError(413, "BODY_TOO_LARGE", "请求过大");
          }
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new HubError(400, "INVALID_REQUEST", "JSON 不正确");
        }
        if (
          !body ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          !Number.isSafeInteger(body.choice) ||
          body.choice < 0
        )
          throw new HubError(400, "INVALID_CHOICE", "只能提交一个原有选项序号");
        return json(res, 200, await hubClient.answer(id, body.choice));
      }
      const resource = resources.get(raw);
      if (resource && ["GET", "HEAD"].includes(req.method || "")) {
        res.writeHead(200, { "content-type": `${resource.type}; charset=utf-8` });
        return res.end(req.method === "HEAD" ? undefined : resource.content);
      }
      throw new HubError(404, "INVALID_REQUEST", "此入口不存在");
    })().catch((error) => {
      if (res.destroyed) return;
      const known = error instanceof HubError ? error : new HubError(502, "UPSTREAM_UNAVAILABLE", "无法读取中台");
      json(res, known.status, { error: known.message, code: known.code });
    });
  });
  server.on("close", () => hubClient.close());
  return server;
}
