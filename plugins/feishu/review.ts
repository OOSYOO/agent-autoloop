import { hash, canonical } from "../gitlab/storage.ts";
import { manualTarget } from "../gitlab/manual.ts";
export type Message = {
  message_id: string;
  chat_id: string;
  chat_type?: string;
  sender: { id: string; sender_type?: string };
  content: string;
  mentions?: { id: string }[];
  deleted?: boolean;
  create_time?: string;
  thread_id?: string;
};
export type Policy = { user: string; instanceUrl: string; projects: string[] };
export type ReviewRequest = { id: string; message: Message; urls: string[]; automatic: boolean };
export function targets(text: string, policy: Policy): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`）。，；！？，)\]]+/g)) {
    for (const path of policy.projects) {
      try {
        manualTarget(match[0], policy.instanceUrl, path);
        urls.add(match[0]);
      } catch {}
    }
  }
  return [...urls];
}
export function classify(message: Message, context: Message[], policy: Policy): ReviewRequest | null {
  if (
    !/^om_[\w-]+$/.test(message.message_id) ||
    !/^oc_[\w-]+$/.test(message.chat_id) ||
    !message.sender?.id ||
    message.sender.id === policy.user ||
    (message.sender.sender_type !== undefined && message.sender.sender_type !== "user") ||
    message.deleted ||
    typeof message.content !== "string"
  )
    return null;
  const mentions = message.mentions ?? [];
  if (message.chat_type !== "p2p" && !(message.chat_type === "group" && mentions.some((m) => m.id === policy.user)))
    return null;
  const text = message.content;
  const review = /\breview\b|\bcr\b|审查|审一下|审下|帮.{0,6}看(?:一下|下)|麻烦.{0,6}看(?:一下|下)/i.test(text);
  const direct = targets(text, policy);
  if (!review && !direct.length) return null;
  const preceding = context.filter(
    (m) => !m.deleted && m.chat_id === message.chat_id && m.sender?.id === message.sender.id,
  );
  const urls = direct.length ? direct : [...new Set(preceding.flatMap((m) => targets(m.content, policy)))];
  const request =
    /(?:帮(?:我|忙)?|麻烦|请|劳烦).{0,16}(?:review\b|cr\b|审查|审一下|审下|看一下|看下)|(?:can|could|would)\s+you\s+(?:please\s+)?review/i.test(
      text,
    );
  const uncertain =
    /不用|不要|不必|无需|不需要|我(?:来|会|可以)?帮你|完了吗|了没|别.{0,4}(?:审|看|review)|取消|已经|已审|审过|review\s*(?:过|完)|他说|她说|转发|引用|[“”「」]|(?:don't|do not|no need|already)/i.test(
      text,
    );
  const automatic = review && request && !uncertain && urls.length === 1 && mentions.every((m) => m.id === policy.user);
  return {
    id: hash(canonical({ user: policy.user, instance: policy.instanceUrl, message: message.message_id })),
    message,
    urls,
    automatic,
  };
}
export async function collectMessages(call: (args: string[]) => Promise<any>, args: string[]): Promise<Message[]> {
  const messages: Message[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const out = await call([
      ...args,
      "--as",
      "user",
      "--format",
      "json",
      "--no-reactions",
      ...(token ? ["--page-token", token] : []),
    ]);
    if (out.ok !== true || !Array.isArray(out.data?.messages)) throw new Error("飞书消息读取失败或返回格式不完整");
    messages.push(...out.data.messages);
    const more = out.data.has_more === true || out.meta?.pagination?.complete === false;
    token = more ? (out.meta?.pagination?.next_token ?? out.data.page_token) : undefined;
    if (more && (typeof token !== "string" || !token || seen.has(token))) throw new Error("飞书消息分页未完成");
    if (token) seen.add(token);
  } while (token);
  return messages;
}
type Answer = { about: string; choice: number | null; text?: string | null };
export async function handleRequest(
  request: ReviewRequest,
  answers: Answer[],
  submit: (url: string) => Promise<void>,
  policy?: Policy,
) {
  const ask: { key: string; title: string; text: string; options: string[]; about: string }[] = [];
  const answer = answers.find((a) => a.about === request.id);
  if (answer?.choice === 1 || (answer?.choice === 0 && request.urls.length !== 1)) return { ask };
  if (answer?.choice === null && answer.text && policy) {
    const urls = targets(answer.text, policy);
    if (urls.length === 1) {
      await submit(urls[0]);
      return { ask };
    }
  }
  if ((request.automatic && !answer) || (answer?.choice === 0 && request.urls.length === 1)) {
    for (const url of request.urls) await submit(url);
    return { ask };
  }
  // Only owner answers may select targets; chat text never changes commands or execution policy.
  if (
    answer &&
    answer.choice !== null &&
    answer.choice >= 2 &&
    request.urls.length <= 3 &&
    request.urls[answer.choice - 2]
  ) {
    await submit(request.urls[answer.choice - 2]);
    return { ask };
  }
  ask.push({
    key: `feishu-review:${request.id}`,
    title: "这条消息需要我审查吗？",
    text: `发起人：${request.message.sender.id}\n会话：${request.message.chat_id}\n消息：${request.message.message_id}\n${request.message.content.slice(0, 2000)}\n${request.urls.join("\n").slice(0, 1400)}\n${request.urls.length ? "确认后按现有审查与发布规则处理；也可用命令行 answer 回复一个 MR 链接。" : "未找到明确的已配置 MR 链接；可用命令行 answer 回复一个 MR 链接，或忽略。"}`,
    options:
      request.urls.length === 1
        ? ["开始审查", "忽略"]
        : [
            "我来处理",
            "忽略",
            ...(request.urls.length <= 3 ? request.urls.map((_, i) => `审查第 ${i + 1} 个 MR`) : []),
          ],
    about: request.id,
  });
  return { ask };
}
