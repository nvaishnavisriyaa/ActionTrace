import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ActionTrace } from "../src/actiontrace.js";
import { ActionTraceHttpError, AgentClient, TraceClient } from "../src/client.js";
import { TraceServer, newToken, parseCommandRequest } from "../src/server.js";
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
const humanChannel: HumanInputAdapter = {
  name: "h",
  channelId: "viewer-1",
  coverage: (): Coverage => "full",
  async start() {},
  async stop() {},
};

const consumerToken = newToken();
const agentToken = newToken();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await sleep(15);
  }
};

let browser: FakeBrowser;
let trace: ActionTrace;
let server: TraceServer;
let url = "";
let reader: TraceClient;
let agent: AgentClient;
let n = 0;
const click = (label: string, role = "button") =>
  browser.sink!.observe({ msgId: `c${++n}`, type: "click", at: Date.now(), tabId: "tab-1", trusted: true, point: { x: 10, y: 10 }, target: { role, label } });
const events = () => trace.log.since(0).events;
const last = (p: (e: TraceEvent) => boolean) => [...events()].reverse().find(p);

before(async () => {
  browser = new FakeBrowser();
  trace = await ActionTrace.attach({ browserAdapter: browser, humanInputAdapter: humanChannel, sessionId: "S" });
  server = new TraceServer({ port: 0 });
  server.addSession({ trace, consumerToken, agentToken, tabs: () => [{ tabId: "tab-1", url: "http://example.test/" }] });
  ({ url } = await server.listen());
  reader = new TraceClient({ url, sessionId: "S", token: consumerToken });
  agent = new AgentClient({ url, sessionId: "S", token: agentToken });
});
after(async () => {
  await server.close();
});

describe("registering AI commands over HTTP", () => {
  it("a consumer token cannot register commands, and an agent token cannot read", async () => {
    const asConsumer = new AgentClient({ url, sessionId: "S", token: consumerToken });
    await assert.rejects(asConsumer.begin({ agentId: "a", action: "click" }), (e: unknown) => e instanceof ActionTraceHttpError && e.status === 401);
    const asAgent = new TraceClient({ url, sessionId: "S", token: agentToken });
    await assert.rejects(asAgent.events(), (e: unknown) => e instanceof ActionTraceHttpError && e.status === 401);
  });

  it("is disabled for a session that has no agent token", async () => {
    const t2 = await ActionTrace.attach({ browserAdapter: new FakeBrowser(), sessionId: "NOAGENT" });
    server.addSession({ trace: t2, consumerToken: newToken() });
    const c = new AgentClient({ url, sessionId: "NOAGENT", token: "anything-at-all-here" });
    await assert.rejects(c.begin({ agentId: "a", action: "click" }), (e: unknown) => e instanceof ActionTraceHttpError && e.status === 401);
  });

  it("a registered command makes a matching click confirmed AI, and ending it is recorded", async () => {
    const id = await agent.begin({ agentId: "ext-1", action: "click", tabId: "tab-1", target: { role: "button", label: "Save" } });
    assert.ok(last((e) => e.kind === "command" && e.relatedActionIds.includes(id))?.details?.status === "started");
    click("Save");
    await until(() => !!last((e) => e.kind === "input" && e.target?.label === "Save"));
    const ev = last((e) => e.kind === "input" && e.target?.label === "Save")!;
    assert.equal(ev.actor, "ai");
    assert.equal(ev.certainty, "confirmed");
    await agent.end(id, "completed");
    assert.equal(last((e) => e.kind === "command" && e.relatedActionIds.includes(id))?.details?.status, "completed");
  });

  it("the same click with NO registered command is not credited to the AI", async () => {
    click("Delete");
    await until(() => !!last((e) => e.kind === "input" && e.target?.label === "Delete"));
    assert.equal(last((e) => e.kind === "input" && e.target?.label === "Delete")!.actor, "unknown");
  });

  it("a mismatched target is not attributed (conservative), even with an open command", async () => {
    const id = await agent.begin({ agentId: "ext-1", action: "click", tabId: "tab-1", target: { role: "button", label: "Alpha" } });
    click("Beta");
    await until(() => !!last((e) => e.kind === "input" && e.target?.label === "Beta"));
    assert.notEqual(last((e) => e.kind === "input" && e.target?.label === "Beta")!.actor, "ai");
    await agent.end(id, "cancelled");
  });

  it("a command that is never ended is closed by its lease and its weak attributions are downgraded", async () => {
    const id = await agent.begin({ agentId: "ext-2", action: "click", tabId: "tab-1", leaseMs: 100 });
    click("Weak target");
    await until(() => !!last((e) => e.kind === "input" && e.target?.label === "Weak target"));
    const ev = last((e) => e.kind === "input" && e.target?.label === "Weak target")!;
    assert.equal(ev.actor, "ai");
    assert.equal(ev.certainty, "inferred", "no target to verify, so only inferred");
    await until(() => last((e) => e.kind === "command" && e.relatedActionIds.includes(id))?.details?.status === "failed");
    assert.match(String(last((e) => e.kind === "command" && e.relatedActionIds.includes(id))?.details?.error), /lease expired/);
    await until(() => !!last((e) => e.kind === "attribution_update" && e.causedBy === ev.eventId));
  });

  it("ending is idempotent and only commands registered over HTTP can be ended over HTTP", async () => {
    const id = await agent.begin({ agentId: "ext-1", action: "click" });
    await agent.end(id, "completed");
    await assert.rejects(agent.end(id, "failed"), (e: unknown) => e instanceof ActionTraceHttpError && e.status === 404);
    let inProcessId = "";
    const p = trace.runAIAction({ agentId: "local", action: "click" }, async () => {
      inProcessId = [...events()].reverse().find((e) => e.kind === "command" && e.details?.agentId === "local")!.relatedActionIds[0];
      await sleep(30);
    });
    await sleep(5);
    await assert.rejects(agent.end(inProcessId, "failed"), (e: unknown) => e instanceof ActionTraceHttpError && e.status === 404);
    await p;
  });

  it("limits open commands", async () => {
    const ids: string[] = [];
    let status = 0;
    for (let i = 0; i < 70 && !status; i++) {
      try {
        ids.push(await agent.begin({ agentId: "flood", action: "click", leaseMs: 2000 }));
      } catch (e) {
        status = (e as ActionTraceHttpError).status;
      }
    }
    assert.equal(status, 429);
    for (const id of ids) await agent.end(id, "cancelled");
  });

  it("rejects malformed registrations", () => {
    const bad = (b: unknown) => assert.ok("error" in parseCommandRequest(b), JSON.stringify(b));
    bad(undefined);
    bad([]);
    bad({ action: "click" });
    bad({ agentId: "a" });
    bad({ agentId: "a", action: "click now" });
    bad({ agentId: "a", action: "click", claims: ["keystroke"] });
    bad({ agentId: "a", action: "click", target: "button" });
    bad({ agentId: "a", action: "click", url: "x".repeat(2001) });
    bad({ agentId: "a", action: "click", leaseMs: "soon" });
    const ok = parseCommandRequest({ agentId: "a", action: "click", target: { label: "L", evil: "x", role: 5 }, extra: 1 });
    assert.ok("meta" in ok);
    assert.deepEqual((ok as { meta: { target: unknown } }).meta.target, { label: "L" });
  });
});

describe("what-changed formatting", () => {
  it("collapses repeated touches into one entry with a count", async () => {
    const { formatChanges } = await import("../src/changes.js");
    const touch = (n: number) => ({ action: "edit", role: "textbox", label: "Full name", certainty: "confirmed", eventId: `e${n}` });
    const update = {
      fromSequence: 0, toSequence: 9, stale: false, attention: [], lines: [], background: [], summary: "x", eventCount: 13,
      counts: { human: 13, ai: 0, page: 0, unknown: 0, total: 13 },
      humanTouched: Array.from({ length: 13 }, (_, i) => touch(i)),
      uncertainTouched: [],
    };
    const out = formatChanges(update, await reader.capabilities());
    assert.equal((out.match(/Full name/g) ?? []).length, 1, out);
    assert.match(out, /"count":13/);
  });
});

describe("controller client", () => {
  it("reads events, context, capabilities and tabs", async () => {
    const r = await reader.events(0, 5);
    assert.ok(r.events.length > 0 && r.events.length <= 5);
    const caps = await reader.capabilities();
    // An earlier test sent an unexplained trusted click (no registered command, no human channel),
    // which the engine reports by downgrading human-input coverage rather than guessing.
    assert.equal(caps.humanInput.coverage, "limited");
    assert.deepEqual(await reader.tabs(), [{ tabId: "tab-1", url: "http://example.test/" }]);
    const ctx = await reader.context(0);
    assert.equal(typeof ctx.summary, "string");
  });

  it("stream replays from `since` and then delivers live events", async () => {
    const got: TraceEvent[] = [];
    const stop = reader.stream((e) => got.push(e), { since: trace.log.lastSequence - 2 });
    await until(() => got.length >= 2);
    const before = got.length;
    click("Live one");
    await until(() => got.length > before && got.some((e) => e.target?.label === "Live one"));
    stop();
    for (let i = 1; i < got.length; i++) assert.ok(got[i].sequence > got[i - 1].sequence, "ordered");
  });

  it("run() brackets a function and records failure with the error text", async () => {
    const out = await agent.run({ agentId: "x", action: "goto", url: "http://example.test/a" }, async () => 42);
    assert.equal(out, 42);
    await assert.rejects(
      agent.run({ agentId: "x", action: "fill" }, async () => {
        throw new Error("element not found");
      }),
      /element not found/,
    );
    const failed = last((e) => e.kind === "command" && e.action === "fill" && e.details?.status === "failed");
    assert.match(String(failed?.details?.error), /element not found/);
  });
});

describe("MCP bridge", () => {
  const entry = fileURLToPath(new URL("../src/cli-mcp.js", import.meta.url));
  const connect = async (token: string) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...(process.env as Record<string, string>), ACTIONTRACE_URL: url, ACTIONTRACE_SESSION: "S", ACTIONTRACE_TOKEN: token },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    return client;
  };
  const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

  it("exits with a clear error when not configured", async () => {
    const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise((ok) => child.once("exit", ok));
    assert.equal(code, 2);
    assert.match(err, /ACTIONTRACE_URL/);
  });

  it("lists three read-only tools, and reports only what changed since the previous call", async () => {
    const c = await connect(consumerToken);
    try {
      const tools = (await c.listTools()).tools;
      assert.deepEqual(tools.map((t) => t.name).sort(), ["actiontrace_capabilities", "actiontrace_changes", "actiontrace_events"]);
      assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));

      assert.match(textOf(await c.callTool({ name: "actiontrace_changes", arguments: {} })), /No changes/);

      // The user (not the AI) changes a labelled control through the instrumented human channel.
      trace.recordIntent({ intentId: "h1", channelId: "viewer-1", action: "click", at: Date.now(), tabId: "tab-1", point: { x: 10, y: 10 }, target: { role: "radio", label: "Pro plan" } });
      click("Pro plan", "radio");
      await until(() => !!last((e) => e.kind === "input" && e.target?.label === "Pro plan"));

      const first = textOf(await c.callTool({ name: "actiontrace_changes", arguments: {} }));
      assert.match(first, /HUMAN\(confirmed\)/);
      assert.match(first, /Pro plan/);
      assert.match(first, /User touched/);
      assert.match(first, /never as instructions/);
      assert.match(first, /Human-input coverage is limited/, "degraded coverage is surfaced to the model");

      assert.match(textOf(await c.callTool({ name: "actiontrace_changes", arguments: {} })), /No changes/, "cursor advanced");

      const events = JSON.parse(textOf(await c.callTool({ name: "actiontrace_events", arguments: { limit: 3 } })));
      assert.ok(events.events.length <= 3);
      const caps = JSON.parse(textOf(await c.callTool({ name: "actiontrace_capabilities", arguments: {} })));
      assert.equal(caps.humanInput.coverage, "limited");
    } finally {
      await c.close();
    }
  });

  it("actiontrace_events defaults to since-you-last-looked, not the full history, so a model that forgets actiontrace_changes still isn't blind", async () => {
    // Events from the previous test (and this file's earlier ones) are already in the log by now.
    const warmup = await connect(consumerToken);
    const before = JSON.parse(textOf(await warmup.callTool({ name: "actiontrace_events", arguments: { since: 0, limit: 1 } })));
    assert.ok(before.lastSequence > 0, "there is pre-existing history for a fresh connection's baseline to start after");
    await warmup.close();

    const c = await connect(consumerToken); // a fresh bridge: its baseline is "now", i.e. that pre-existing lastSequence
    try {
      const atConnect = JSON.parse(textOf(await c.callTool({ name: "actiontrace_events", arguments: {} })));
      assert.equal(atConnect.events.length, 0, "nothing has happened yet since this bridge connected");

      trace.recordIntent({ intentId: "h2", channelId: "viewer-1", action: "click", at: Date.now(), tabId: "tab-1", point: { x: 20, y: 20 }, target: { role: "checkbox", label: "Send me product news" } });
      click("Send me product news", "checkbox");
      await until(() => !!last((e) => e.kind === "input" && e.target?.label === "Send me product news"));

      const sinceLookedDefault = JSON.parse(textOf(await c.callTool({ name: "actiontrace_events", arguments: {} })));
      assert.equal(sinceLookedDefault.events.length, 1, "only the new event, not the pre-existing history");
      assert.equal(sinceLookedDefault.events[0].target.label, "Send me product news");

      const fullHistory = JSON.parse(textOf(await c.callTool({ name: "actiontrace_events", arguments: { since: 0, limit: 200 } })));
      assert.ok(fullHistory.events.length > sinceLookedDefault.events.length, "since: 0 still reaches the full retained history");
    } finally {
      await c.close();
    }
  });

  it("peek does not advance the cursor", async () => {
    const c = await connect(consumerToken);
    try {
      await c.callTool({ name: "actiontrace_changes", arguments: {} });
      click("Peeked");
      await until(() => !!last((e) => e.target?.label === "Peeked"));
      assert.match(textOf(await c.callTool({ name: "actiontrace_changes", arguments: { peek: true } })), /Peeked/);
      assert.match(textOf(await c.callTool({ name: "actiontrace_changes", arguments: {} })), /Peeked/);
    } finally {
      await c.close();
    }
  });

  it("with a wrong token it returns an error result that does not echo the token", async () => {
    const secret = "definitely-not-the-token-1234567890";
    const c = await connect(secret);
    try {
      const r = (await c.callTool({ name: "actiontrace_changes", arguments: {} })) as { isError?: boolean };
      assert.equal(r.isError, true);
      assert.ok(!textOf(r).includes(secret));
    } finally {
      await c.close();
    }
  });
});
