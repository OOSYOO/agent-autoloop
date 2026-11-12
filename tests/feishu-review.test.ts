// Failure modes: discussion or other people's mentions authorize reviews; split messages lose targets; replay duplicates work.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, collectMessages, handleRequest } from "../plugins/feishu/review.ts";
const url = "https://gitlab.example.com/team/repo/-/merge_requests/7";
const policy = { user: "ou_me", instanceUrl: "https://gitlab.example.com", projects: ["team/repo"] };
const message = (content: string, extra = {}) => ({
  message_id: "om_1",
  chat_id: "oc_1",
  chat_type: "p2p",
  sender: { id: "ou_peer", sender_type: "user" },
  content,
  ...extra,
});
test("explicit direct requests enter review; ambiguous and negative language never auto authorizes", () => {
  assert.equal(classify(message(`帮我 review 一下 ${url}`), [], policy)?.automatic, true);
  for (const text of [
    `${url}`,
    `这个 review 过了吗 ${url}`,
    `请问你帮我 review 完了吗 ${url}`,
    `我帮你 review ${url}`,
    `不用你 review ${url}`,
    `他说帮我 review ${url}`,
    `帮我 review ${url} https://gitlab.example.com/team/repo/-/merge_requests/8`,
  ])
    assert.equal(classify(message(text), [], policy)?.automatic, false);
  assert.equal(classify(message("午饭吃什么"), [], policy), null);
  assert.equal(classify(message(`帮我 review ${url}`, { sender: { id: "ou_me" } }), [], policy), null);
  assert.equal(classify(message(`帮我 review ${url}`, { deleted: true }), [], policy), null);
});
test("group requests require an actual owner mention; multiple recipients are ambiguous", () => {
  assert.equal(
    classify(message(`帮忙 review ${url}`, { chat_type: "group", mentions: [{ id: "ou_other" }] }), [], policy),
    null,
  );
  assert.equal(
    classify(message(`帮忙 review ${url}`, { chat_type: "group", mentions: [{ id: "ou_me" }] }), [], policy)?.automatic,
    true,
  );
  assert.equal(
    classify(
      message(`帮忙 review ${url}`, { chat_type: "group", mentions: [{ id: "ou_me" }, { id: "ou_other" }] }),
      [],
      policy,
    )?.automatic,
    false,
  );
});
test("same sender's preceding link supplies target but never supplies the request instruction", () => {
  assert.equal(classify(message("帮忙看一下"), [message(url)], policy)?.automatic, true);
  assert.equal(classify(message("好的"), [message(`帮忙 review ${url}`)], policy), null);
  assert.equal(
    classify(message("帮忙 review"), [message(url, { sender: { id: "ou_other" } })], policy)?.automatic,
    false,
  );
  assert.deepEqual(
    classify(message(`帮忙 review https://evil.test/team/repo/-/merge_requests/7`), [], policy)?.urls,
    [],
  );
});
test("pagination follows remaining tokens and rejects incomplete responses", async () => {
  const calls: string[][] = [];
  const rows = await collectMessages(
    async (args) => {
      calls.push(args);
      return { ok: true, data: { messages: [message(url)], has_more: calls.length === 1, page_token: "next" } };
    },
    ["im", "+messages-search"],
  );
  assert.equal(rows.length, 2);
  assert.ok(calls[1].includes("next"));
  await assert.rejects(collectMessages(async () => ({ ok: true, data: { messages: [], has_more: true } }), []));
  await assert.rejects(collectMessages(async () => ({ ok: false, error: {} }), []));
});
test("ambiguous requests end with a card and only its positive answer submits trusted targets", async () => {
  const request = { id: "a".repeat(64), message: message(url), urls: [url], automatic: false };
  const submitted: string[] = [];
  const submit = async (target: string) => {
    submitted.push(target);
  };
  const first = await handleRequest(request, [], submit);
  assert.equal(first.ask.length, 1);
  assert.equal(submitted.length, 0);
  const answer = { about: request.id, choice: 0, text: null };
  await handleRequest(request, [answer], submit);
  assert.deepEqual(submitted, [url]);
  submitted.length = 0;
  await handleRequest(request, [{ ...answer, choice: 1 }], submit);
  assert.equal(submitted.length, 0);
  await handleRequest(request, [{ ...answer, about: "forged" }], submit);
  assert.equal(submitted.length, 0);
});

test("many targets remain within card limits; an owner can supply a missing configured MR", async () => {
  const request = { id: "b".repeat(64), message: message("帮忙 review"), urls: [], automatic: false };
  const submitted: string[] = [];
  await handleRequest(
    request,
    [{ about: request.id, choice: null, text: url }],
    async (target) => {
      submitted.push(target);
    },
    policy,
  );
  assert.deepEqual(submitted, [url]);
  const many = await handleRequest(
    { ...request, urls: Array.from({ length: 8 }, (_, i) => url + i) },
    [],
    async () => {},
  );
  assert.ok(many.ask[0].options.length <= 5);
  assert.ok(many.ask[0].text.length <= 4000);
  const handled = await handleRequest(request, [{ about: request.id, choice: 0 }], async () =>
    assert.fail("no target"),
  );
  assert.equal(handled.ask.length, 0);
});
