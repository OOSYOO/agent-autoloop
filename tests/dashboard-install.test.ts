// Failure modes: installed dashboard depends on another checkout, upgrade serves mixed assets,
// stale pages can approve after restart, or shutdown leaves upstream requests alive.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { installLocal } from "../cli/local-install.ts";
import { state } from "./dashboard-fixture.ts";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, "exit");
  child.kill("SIGTERM");
  await done;
}
async function start(program: string, home: string, port: number) {
  const child = spawn(process.execPath, [program, "dashboard"], {
    cwd: home,
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (c) => (output += c));
  child.stderr!.on("data", (c) => (output += c));
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      if (output.includes("本地任务看板：http")) return;
      if (child.exitCode !== null) throw new Error(output);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("dashboard did not start: " + output);
  };
  try {
    await ready();
    return child;
  } catch (error) {
    await stop(child);
    throw error;
  }
}

test(
  "installed lifecycle freezes assets, rejects old instances and aborts body reads on shutdown",
  { timeout: 30000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "dashboard-install-"));
    let hang = false,
      writes = 0,
      disconnected = false;
    const upstream = createServer((req, res) => {
      if (req.method === "POST") writes++;
      if (hang) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        res.on("close", () => (disconnected = true));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state()));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const program = installLocal(resolve(import.meta.dirname, ".."), home);
    writeFileSync(join(home, "config.json"), JSON.stringify({ url: upstreamUrl, owner: "fake-owner" }));
    const port = await freePort(),
      base = `http://127.0.0.1:${port}`;
    let child = await start(program, home, port);
    t.after(async () => {
      await stop(child);
      upstream.closeAllConnections();
      upstream.close();
      rmSync(home, { recursive: true, force: true });
    });
    const old = (await fetch(base + "/api/state")).headers.get("x-dashboard-instance")!;
    const original = await (await fetch(base + "/app.js")).text();
    writeFileSync(join(home, "app/dashboard/public/app.js"), "replacement-on-disk");
    assert.equal(await (await fetch(base + "/app.js")).text(), original);
    await stop(child);
    assert.equal((await fetch(upstreamUrl)).status, 200, "hub survives dashboard shutdown");
    installLocal(resolve(import.meta.dirname, ".."), home);
    child = await start(program, home, port);
    const current = (await fetch(base + "/api/state")).headers.get("x-dashboard-instance")!;
    assert.notEqual(current, old);
    const post = await fetch(base + "/api/cards/1/answer", {
      method: "POST",
      headers: {
        origin: base,
        "content-type": "application/json",
        "x-dashboard-action": "answer",
        "x-dashboard-instance": old,
      },
      body: '{"choice":0}',
    });
    assert.equal(post.status, 409);
    assert.equal((await post.json()).code, "PAGE_RELOAD_REQUIRED");
    assert.equal(writes, 0);
    hang = true;
    const pending = fetch(base + "/api/state").catch(() => null);
    await new Promise((r) => setTimeout(r, 80));
    await stop(child);
    await pending;
    for (let i = 0; i < 30 && !disconnected; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(disconnected, true);
  },
);

test("invalid ports and non-loopback or secretless configuration fail before listening", () => {
  const home = mkdtempSync(join(tmpdir(), "dashboard-config-"));
  const program = resolve(import.meta.dirname, "../bin/agent-autoloop.ts");
  try {
    for (const config of [
      { url: "https://evil.test", owner: "x" },
      { url: "http://127.0.0.1:3350", owner: "" },
      { url: "http://x:y@localhost:3350", owner: "x" },
      { url: "http://localhost:3350?x=1", owner: "x" },
    ]) {
      writeFileSync(join(home, "config.json"), JSON.stringify(config));
      const r = spawnSync(process.execPath, [program, "dashboard"], {
        env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
        encoding: "utf8",
        timeout: 3000,
      });
      assert.equal(r.status, 1, r.stderr);
    }
    writeFileSync(join(home, "config.json"), JSON.stringify({ url: "http://127.0.0.1:3350", owner: "x" }));
    for (const port of ["0", "abc", "65536", ""]) {
      const r = spawnSync(process.execPath, [program, "dashboard"], {
        env: { ...process.env, AGENT_AUTOLOOP_HOME: home, PORT: port },
        encoding: "utf8",
        timeout: 3000,
      });
      assert.equal(r.status, 1, r.stderr);
    }
    assert.match(readFileSync(join(home, "config.json"), "utf8"), /3350/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
