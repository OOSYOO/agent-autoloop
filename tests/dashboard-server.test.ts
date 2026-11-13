// Failure modes: a local page becomes an arbitrary owner proxy, a write is silently retried,
// stale pages approve after restart, or header-only upstream responses outlive the timeout.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { createHubClient } from "../dashboard/src/hub-client.ts";
import { createDashboardServer } from "../dashboard/src/server.ts";
import { state } from "./dashboard-fixture.ts";

async function fixture(t: any, handler: any, timeoutMs = 100) {
  const upstream = createServer(handler);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const port = (upstream.address() as any).port;
  const client = createHubClient({ hubUrl: new URL(`http://127.0.0.1:${port}`), owner: "SECRET", timeoutMs });
  const server = createDashboardServer({ hubClient: client });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(() => {
    client.close();
    server.closeAllConnections();
    server.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const read = await fetch(base + "/api/state");
  const instance = read.headers.get("x-dashboard-instance")!;
  const headers = {
    origin: base,
    "content-type": "application/json",
    "x-dashboard-action": "answer",
    "x-dashboard-instance": instance,
  };
  return { base, headers, read, client };
}
const json = (res: any, value: any) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
};

test("fixed write boundary rejects forged requests before upstream calls; exact choice is forwarded", async (t) => {
  let writes = 0,
    reads = 0;
  const f = await fixture(t, (req: any, res: any) => {
    assert.equal(req.headers.authorization, "Bearer SECRET");
    if (req.method === "GET") {
      reads++;
      return json(res, state());
    }
    writes++;
    let body = "";
    req.on("data", (c: any) => (body += c));
    req.on("end", () => {
      assert.equal(body, '{"choice":1}');
      json(res, { changed: true, state: "decided" });
    });
  });
  assert.equal(f.read.status, 200);
  assert.ok(!(await f.read.text()).includes("SECRET"));
  for (const headers of [
    { ...f.headers, origin: "http://evil.test" },
    { ...f.headers, origin: "null" },
    { ...f.headers, "x-dashboard-instance": "old" },
    { ...f.headers, "sec-fetch-site": "cross-site" },
  ]) {
    const r = await fetch(f.base + "/api/cards/1/answer", { method: "POST", headers, body: '{"choice":1}' });
    assert.ok([403, 409].includes(r.status));
  }
  for (const body of ['{"choice":0,"text":"yes"}', '{"choice":99}', '{"choice":-1}', "null", "[]"]) {
    assert.equal(
      (await fetch(f.base + "/api/cards/1/answer", { method: "POST", headers: f.headers, body })).status,
      400,
    );
  }
  assert.equal(writes, 0);
  const before = reads;
  const ok = await fetch(f.base + "/api/cards/1/answer", { method: "POST", headers: f.headers, body: '{"choice":1}' });
  assert.deepEqual(await ok.json(), { changed: true, state: "decided" });
  assert.equal(writes, 1);
  assert.equal(reads, before + 1);
  for (const path of [
    "/api/state?before=1",
    "/api/cards/0/answer",
    "/api/cards/9007199254740992/answer",
    "/api/runs/1/why",
  ])
    assert.ok((await fetch(f.base + path)).status >= 400);
  const page = await fetch(f.base);
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
});

test("malformed state and unauthorized upstream responses never leak upstream bodies", async (t) => {
  for (const payload of [
    {},
    { ...state(), cards: {} },
    { ...state(), totals: {} },
    { ...state(), cards: [{ ...state().cards[0], options: [true] }] },
  ]) {
    const f = await fixture(t, (_: any, res: any) => json(res, payload));
    assert.equal(f.read.status, 502);
    assert.equal((await f.read.json()).code, "UPSTREAM_UNAVAILABLE");
  }
  const f = await fixture(t, (_: any, res: any) => {
    res.statusCode = 401;
    res.end("SECRET");
  });
  assert.equal(f.read.status, 401);
  assert.ok(!(await f.read.text()).includes("SECRET"));
});

test("timeout covers response bodies and distinguishes pre-read from dispatched write", async (t) => {
  let writes = 0,
    hangRead = false;
  const f = await fixture(
    t,
    (req: any, res: any) => {
      if (req.method === "GET" && !hangRead) return json(res, state());
      if (req.method === "POST") writes++;
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    },
    40,
  );
  const r = await fetch(f.base + "/api/cards/1/answer", { method: "POST", headers: f.headers, body: '{"choice":0}' });
  assert.equal((await r.json()).code, "OUTCOME_UNKNOWN");
  assert.equal(writes, 1);
  hangRead = true;
  const r2 = await fetch(f.base + "/api/cards/1/answer", { method: "POST", headers: f.headers, body: '{"choice":0}' });
  assert.equal((await r2.json()).code, "UPSTREAM_TIMEOUT");
  assert.equal(writes, 1);
});

test("redirects, unsafe hosts, missing origins, media types and oversized bodies cannot become owner writes", async (t) => {
  let writes = 0;
  const f = await fixture(t, (req: any, res: any) => {
    if (req.method === "POST") writes++;
    json(res, state());
  });
  for (const headers of [
    { ...f.headers, origin: "" },
    { ...f.headers, "x-dashboard-action": "" },
    { ...f.headers, authorization: "Bearer browser" },
  ]) {
    assert.equal(
      (await fetch(f.base + "/api/cards/1/answer", { method: "POST", headers, body: '{"choice":0}' })).status,
      403,
      JSON.stringify(headers),
    );
  }
  for (const host of ["localhost:1", "evil.test", new URL(f.base).host + "/path", "user@" + new URL(f.base).host]) {
    const status = await new Promise<number>((resolve) => {
      const req = request(f.base, { headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.end();
    });
    assert.equal(status, 403, host);
  }
  assert.equal(
    (
      await fetch(f.base + "/api/cards/1/answer", {
        method: "POST",
        headers: { ...f.headers, "content-type": "text/plain" },
        body: '{"choice":0}',
      })
    ).status,
    415,
  );
  const tooLarge = await fetch(f.base + "/api/cards/1/answer", {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({ choice: 0, padding: "x".repeat(1024 * 1024) }),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(writes, 0);
  const redirected = await fixture(t, (_: any, res: any) => {
    res.writeHead(302, { location: f.base + "/api/state" });
    res.end();
  });
  assert.equal(redirected.read.status, 502);
});

test("after dispatch, malformed successes and upstream failures are unknown; authentication is explicit", async (t) => {
  for (const [status, body, code] of [
    [200, {}, "OUTCOME_UNKNOWN"],
    [500, { error: "SECRET" }, "OUTCOME_UNKNOWN"],
    [401, { error: "SECRET" }, "UPSTREAM_AUTH_FAILED"],
  ] as const) {
    const f = await fixture(t, (req: any, res: any) => {
      if (req.method === "GET") return json(res, state());
      res.statusCode = status;
      json(res, body);
    });
    const r = await fetch(f.base + "/api/cards/1/answer", { method: "POST", headers: f.headers, body: '{"choice":0}' });
    const payload = await r.json();
    assert.equal(payload.code, code);
    assert.ok(!JSON.stringify(payload).includes("SECRET"));
  }
});
