import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../gitlab/config.ts";
import { atomicFile, hash } from "../gitlab/storage.ts";
import { scanGitlab } from "../gitlab/poll.ts";
import { classify, collectMessages, handleRequest, type ReviewRequest, type Message } from "./review.ts";

class AccessError extends Error {}

// lark-cli forwards fractional seconds to an API that only accepts whole seconds.
const larkTime = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");

export async function runFeishuReview(action: string, file: string) {
  const settings = JSON.parse(readFileSync(file, "utf8"));
  if (
    !/^ou_[\w-]+$/.test(settings.user) ||
    typeof settings.gitlabConfig !== "string" ||
    !settings.gitlabConfig ||
    (settings.lark !== undefined && (typeof settings.lark !== "string" || !settings.lark))
  )
    throw new Error("飞书审查配置无效");
  if (
    settings.route !== undefined &&
    (typeof settings.route !== "string" || !/^[a-z][a-z0-9-]{0,30}$/.test(settings.route))
  )
    throw new Error("飞书路由名称无效");
  if (settings.askUnmatched !== undefined && typeof settings.askUnmatched !== "boolean")
    throw new Error("飞书模糊请求配置无效");
  const eventType = settings.route ? `feishu.review.request.${settings.route}` : "feishu.review.request";
  const scoped = (request: ReviewRequest) =>
    settings.route ? { ...request, id: hash(`${settings.route}:${request.id}`) } : request;
  const configFile = resolve(dirname(file), settings.gitlabConfig);
  const config = loadConfig(configFile);
  const root = join(config.dataRoot, "feishu-review", config.instanceKey, settings.user);
  const policy = {
    user: settings.user,
    instanceUrl: config.instanceUrl,
    projects: config.projects.map((p) => p.projectPath ?? ""),
  };
  const requestFile = (id: string) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("飞书请求编号无效");
    return join(root, "requests", `${id}.json`);
  };
  const load = (id: string): ReviewRequest => {
    const request = JSON.parse(readFileSync(requestFile(id), "utf8"));
    if (request.id !== id) throw new Error("飞书请求记录不一致");
    return request;
  };
  const call = (args: string[]) =>
    new Promise<any>((resolve, reject) => {
      execFile(
        settings.lark ?? "lark-cli",
        args,
        { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            try {
              const failure = JSON.parse(stderr);
              if (failure.error?.type === "authorization" || failure.error?.type === "authentication") {
                reject(new AccessError("飞书登录或消息权限需要恢复"));
                return;
              }
            } catch {}
            reject(new Error(`飞书命令失败：${args.slice(0, 2).join(" ")}；请检查登录与消息权限`));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("飞书返回格式无效"));
          }
        },
      );
    });
  if (action === "scan") {
    if (process.env.AGENT_AUTOLOOP_CONTEXT) {
      const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT, "utf8"));
      if (context.open?.some((card: any) => card.title === "飞书消息读取需要处理")) return { ask: [] };
    }
    const status = await call(["auth", "status", "--json"]);
    if (status.identities?.user?.openId !== settings.user) throw new AccessError("飞书登录身份与配置不符");
    const cursorFile = join(root, "cursor.json");
    const end = Date.now();
    if (!existsSync(cursorFile)) atomicFile(cursorFile, JSON.stringify({ at: end - 5 * 60_000 }));
    const cursor = JSON.parse(readFileSync(cursorFile, "utf8"));
    if (!Number.isSafeInteger(cursor.at) || cursor.at < 0 || cursor.at > end) throw new Error("飞书扫描时间记录无效");
    const start = larkTime(Math.max(0, cursor.at - 10 * 60_000));
    const range = ["--start", start, "--end", larkTime(end)];
    const messages = new Map<string, Message>();
    for (const filter of [
      ["--chat-type", "group", "--is-at-me"],
      ["--chat-type", "p2p"],
    ]) {
      for (const message of await collectMessages(call, [
        "im",
        "+messages-search",
        ...filter,
        ...range,
        "--sender-type",
        "user",
      ]))
        messages.set(message.message_id, message);
    }
    const token = readFileSync(config.sourceKeyPath, "utf8").trim();
    if (!token) throw new Error("GitLab 来源密钥为空");
    for (const message of messages.values()) {
      let request = classify(message, [], policy);
      if (!request) continue;
      request = scoped(request);
      if (existsSync(requestFile(request.id))) request = load(request.id);
      else {
        if (!request.urls.length) {
          const at = /^\d+$/.test(String(message.create_time))
            ? Number(message.create_time)
            : Date.parse(message.create_time ?? "");
          if (Number.isFinite(at)) {
            const preceding = await collectMessages(call, [
              "im",
              "+chat-messages-list",
              "--chat-id",
              message.chat_id,
              "--start",
              larkTime(at - 5 * 60_000),
              "--end",
              larkTime(at),
              "--order",
              "asc",
            ]);
            if (message.thread_id) {
              preceding.push(
                ...(await collectMessages(call, [
                  "im",
                  "+threads-messages-list",
                  "--thread",
                  message.thread_id,
                  "--order",
                  "asc",
                ])),
              );
            }
            request = scoped(
              classify(
                message,
                preceding.filter((m) => {
                  const time = /^\d+$/.test(String(m.create_time))
                    ? Number(m.create_time)
                    : Date.parse(m.create_time ?? "");
                  return m.message_id !== message.message_id && Number.isFinite(time) && time <= at;
                }),
                policy,
              )!,
            );
          }
        }
        if (
          !request.urls.length &&
          (settings.askUnmatched === false || /\/-\/merge_requests\/\d/.test(message.content))
        )
          continue;
        atomicFile(requestFile(request.id), JSON.stringify(request), true);
      }
      const response = await fetch(`${config.hubUrl}/v1/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          id: `feishu-review:${request.id}`,
          type: eventType,
          subject: request.id,
          summary: "飞书审查请求",
          detail: JSON.stringify({ requestId: request.id }),
        }),
      });
      if (!response.ok) throw new Error(`飞书请求未交给中台（${response.status}）`);
      const receipt: any = await response.json();
      if (
        !Number.isSafeInteger(receipt.event) ||
        typeof receipt.duplicate !== "boolean" ||
        !Array.isArray(receipt.routed) ||
        receipt.routed.length !== 1
      )
        throw new Error("飞书请求未匹配唯一处理规则；修复后需重新投递未路由事件");
    }
    // Advance only after the Hub durably acknowledges every event, including duplicate deliveries.
    atomicFile(cursorFile, JSON.stringify({ at: end }));
    return { ask: [] };
  }
  if (action !== "review" || !process.env.AGENT_AUTOLOOP_CONTEXT) throw new Error("缺少飞书请求上下文");
  const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT, "utf8"));
  if (!Array.isArray(context.events) || !Array.isArray(context.answers)) throw new Error("飞书请求上下文无效");
  const ids = new Set<string>();
  for (const event of context.events) {
    if (event.source !== "gitlab" || event.type !== eventType || event.id !== `feishu-review:${event.subject}`)
      continue;
    ids.add(event.subject);
  }
  for (const answer of context.answers) ids.add(answer.about);
  const asks = [];
  for (const id of ids) {
    const request = load(id);
    const result = await handleRequest(
      request,
      context.answers,
      async (url) => {
        await scanGitlab(
          [
            "--config",
            configFile,
            "--mr",
            url,
            "--override",
            "reviewer",
            "--reason",
            `飞书请求 ${id}；消息 ${request.message.message_id}；发起人 ${request.message.sender.id}`,
          ],
          true,
        );
      },
      policy,
    );
    asks.push(...result.ask);
  }
  return { ask: asks };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, flag, file] = process.argv.slice(2);
  Promise.resolve()
    .then(() => {
      if (flag !== "--config" || !file || process.argv.length !== 5) throw new Error("请提供 scan/review 和配置路径");
      return runFeishuReview(action, resolve(file));
    })
    .then((result) => console.log(`飞书审查请求已处理\n\`\`\`agent-autoloop\n${JSON.stringify(result)}\n\`\`\``))
    .catch((error) => {
      if (error instanceof AccessError) {
        console.log(
          `待你处理：飞书消息读取需要处理\n\`\`\`agent-autoloop\n${JSON.stringify({ ask: [{ key: "feishu-review:access", title: "飞书消息读取需要处理", text: error.message, options: ["已恢复", "稍后处理"], about: "恢复飞书本人登录与消息读取权限后重新扫描" }] })}\n\`\`\``,
        );
        return;
      }
      console.error((error as Error).message);
      process.exitCode = 1;
    });
}
