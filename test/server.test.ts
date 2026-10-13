import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { ActionTrace } from "../src/actiontrace.js";
import { TraceServer, newToken } from "../src/server.js";
import type { BrowserAdapter, Coverage, HumanInputAdapter, ObservationSink, TraceEvent } from "../src/protocol.js";

class FakeBrowser implements BrowserAdapter {
  name = "fake";
  sink?: ObservationSink;
  capabilities() {
    return { observing: true, click: true, edit: true, scroll: true, navigation: true, mutation: true, tabs: true };
  }
  async start(s: ObservationSink) {
    this.sink = s;
  }
  async stop() {}
}
const human: () => HumanInputAdapter = () => ({
  name: "h",
  channelId: "viewer-1",
  coverage: (): Coverage => "full",
  async start() {},
  async stop() {},
});

let server: TraceServer;
let base = "";
let port = 0;
const a = { trace: undefined as unknown as ActionTrace, browser: new FakeBrowser(), token: newToken() };
const b = { trace: undefined as unknown as ActionTrace, browser: new FakeBrowser(), token: newToken() };
let n = 0;
const mutate = (x: typeof a, count = 1) => {
  for (let i = 0; i < count; i++) {
    x.browser.sink!.observe({ msgId: `m${++n}`, type: "mutation", at: Date.now(), tabId: "tab-1", details: { added: 1 } });
  }
};

before(async () => {
  a.trace = await ActionTrace.attach({ browserAdapter: a.browser, humanInputAdapter: human(), sessionId: "A", bufferSize: 5 });
  b.trace = await ActionTrace.attach({ browserAdapter: b.browser, humanInputAdapter: human(), sessionId: "B" });
  server = new TraceServer({ port: 0 });
  server.addSession({ trace: a.trace, consumerToken: a.token });
  server.addSession({ trace: b.trace, consumerToken: b.token });
  ({ port, url: base } = await server.listen());
});
after(async () => {
  await server.close();
});

function connect(opts: { origin?: string } = {}): Promise<WebSocket> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/stream`, { headers: opts.origin ? { Origin: opts.origin } : {} });
    ws.once("open", () => ok(ws));
    ws.once("error", fail);
    ws.once("unexpected-response", (_req, res) => fail(new Error(`HTTP ${res.statusCode}`)));
  });
}
function collect(ws: WebSocket) {
  const msgs: any[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
  const closed = new Promise<number>((ok) => ws.once("close", (code) => ok(code)));
  return { msgs, closed };
}
const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const get = (path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((ok, fail) => {
    const req = request(base + path, { headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });

describe("event stream server", () => {
  it("rejects a connection that authenticates with the wrong token", async () => {
    const ws = await connect();
    const { closed } = collect(ws);
    ws.send(JSON.stringify({ type: "auth", sessionId: "A", token: "nope" }));
    assert.equal(await closed, 4403);
  });

  it("isolates sessions: session B's token cannot read session A", async () => {
    const ws = await connect();
    const { closed } = collect(ws);
    ws.send(JSON.stringify({ type: "auth", sessionId: "A", token: b.token }));
    assert.equal(await closed, 4403);
    assert.equal((await get("/api/sessions/A/events", { Authorization: `Bearer ${b.token}` })).status, 401);
    assert.equal((await get("/api/sessions/A/events")).status, 401);
    assert.equal((await get("/api/sessions/A/events", { Authorization: `Bearer ${a.token}` })).status, 200);
  });

  it("closes unauthenticated sockets after a timeout", async () => {
    const ws = await connect();
    const { closed } = collect(ws);
    assert.equal(await closed, 4401);
  });

  it("refuses cross-site WebSocket origins and unexpected Host headers", async () => {
    await assert.rejects(() => connect({ origin: "https://evil.example" }), /403/);
    const res = await new Promise<number>((ok, fail) => {
      const req = request({ host: "127.0.0.1", port, path: "/", headers: { Host: "evil.example" } }, (r) => ok(r.statusCode ?? 0));
      req.on("error", fail);
      req.end();
    });
    assert.equal(res, 403);
  });

  it("streams live events and supports resume from a sequence number", async () => {
    const ws1 = await connect();
    const c1 = collect(ws1);
    ws1.send(JSON.stringify({ type: "auth", sessionId: "B", token: b.token }));
    await until(() => c1.msgs.some((m) => m.type === "hello"));
    mutate(b, 3);
    await until(() => c1.msgs.filter((m) => m.type === "event").length >= 3);
    const seqs = c1.msgs.filter((m) => m.type === "event").map((m) => m.event.sequence as number);
    ws1.close();

    mutate(b, 2); // missed while disconnected
    const ws2 = await connect();
    const c2 = collect(ws2);
    const last = Math.max(...seqs);
    ws2.send(JSON.stringify({ type: "auth", sessionId: "B", token: b.token, since: last }));
    await until(() => c2.msgs.filter((m) => m.type === "event").length >= 2);
    const replayed = c2.msgs.filter((m) => m.type === "event").map((m) => m.event as TraceEvent);
    assert.ok(replayed.every((e) => e.sequence > last));
    assert.ok(!replayed.some((e) => e.kind === "stream_gap"));
    ws2.close();
  });

  it("reports an explicit gap when the requested events were evicted", async () => {
    mutate(a, 12); // buffer holds 5
    const ws = await connect();
    const c = collect(ws);
    ws.send(JSON.stringify({ type: "auth", sessionId: "A", token: a.token, since: 0 }));
    await until(() => c.msgs.some((m) => m.type === "event" && m.event.kind === "stream_gap"));
    const gap = c.msgs.find((m) => m.event?.kind === "stream_gap").event as TraceEvent;
    assert.ok((gap.details as { lost: number }).lost > 0);
    const after = c.msgs.filter((m) => m.type === "event" && m.event.kind !== "stream_gap").map((m) => m.event.sequence as number);
    assert.deepEqual(after, [...after].sort((x, y) => x - y));
    assert.equal(after[0], (gap.details as { toSequence: number }).toSequence + 1);
    ws.close();
  });

  it("serves capabilities and context over HTTP with the bearer token", async () => {
    const caps = JSON.parse((await get("/api/sessions/B/capabilities", { Authorization: `Bearer ${b.token}` })).body);
    assert.equal(caps.humanInput.coverage, "full");
    const ctx = JSON.parse((await get("/api/sessions/B/context?since=0", { Authorization: `Bearer ${b.token}` })).body);
    assert.ok(ctx.summary.length > 0);
  });
});
