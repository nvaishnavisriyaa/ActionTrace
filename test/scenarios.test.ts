import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ActionTrace } from "../src/actiontrace.js";
import { AttributionEngine } from "../src/attribution.js";
import { ContextFeed } from "../src/context.js";
import { EventLog } from "../src/event-log.js";
import type {
  BrowserAdapter,
  BrowserObservation,
  Coverage,
  HumanInputAdapter,
  HumanIntent,
  HumanIntentSink,
  ObservationSink,
  TraceEvent,
} from "../src/protocol.js";

class Harness {
  t = 1_000_000;
  log = new EventLog("s1", 1000);
  coverage: Coverage = "full";
  uninstrumented = 0;
  n = 0;
  engine = new AttributionEngine(
    this.log,
    { humanCoverage: () => this.coverage, onUninstrumentedInput: () => void this.uninstrumented++ },
    { now: () => this.t },
  );

  obs(o: Partial<BrowserObservation> & Pick<BrowserObservation, "type">): TraceEvent | undefined {
    return this.engine.ingest({ msgId: `m${++this.n}`, at: this.t, tabId: "tab-1", documentId: "doc-1", trusted: true, ...o });
  }
  human(i: Partial<HumanIntent> & Pick<HumanIntent, "action">): void {
    this.engine.registerHumanIntent({ intentId: `h${++this.n}`, channelId: "viewer-1", at: this.t, tabId: "tab-1", ...i });
  }
  ofKind(kind: TraceEvent["kind"]) {
    return this.log.since(0).events.filter((e) => e.kind === kind);
  }
}

const CONTINUE = { role: "button", label: "Continue" };

describe("acceptance scenarios", () => {
  it("1. AI clicks while the user scrolls: both sources stay distinguishable", () => {
    const h = new Harness();
    h.engine.beginCommand({ agentId: "agent-1", action: "click", tabId: "tab-1", target: CONTINUE });
    h.human({ action: "scroll", point: { x: 300, y: 300 }, scroll: { dx: 0, dy: 120 } });
    h.t += 10;
    const click = h.obs({ type: "click", point: { x: 50, y: 60 }, target: CONTINUE })!;
    const scroll = h.obs({ type: "scroll", target: { role: "document" }, details: { dx: 0, dy: 118, events: 4 } })!;
    assert.equal(click.actor, "ai");
    assert.equal(click.certainty, "confirmed");
    assert.equal(scroll.actor, "human");
    assert.equal(scroll.certainty, "confirmed");
    assert.ok(scroll.evidence.some((e) => e.type === "human_channel" && e.channelId === "viewer-1"));
  });

  it("2. near-simultaneous use of the same element stays uncertain", () => {
    const h = new Harness();
    h.engine.beginCommand({ agentId: "agent-1", action: "click", tabId: "tab-1", target: CONTINUE });
    h.human({ action: "click", point: { x: 50, y: 60 } });
    h.t += 5;
    const ev = h.obs({ type: "click", point: { x: 50, y: 60 }, target: CONTINUE })!;
    assert.equal(ev.actor, "unknown");
    assert.equal(ev.certainty, "unknown");
    const comp = ev.evidence.find((e) => e.type === "competing_candidates");
    assert.ok(comp && comp.type === "competing_candidates" && comp.candidates.length === 2);
    assert.equal(ev.relatedActionIds.length, 1);
  });

  it("2b. competition caps certainty at inferred even when one candidate is verified", () => {
    const h = new Harness();
    h.engine.beginCommand({ agentId: "agent-1", action: "click", tabId: "tab-1" }); // no target: weak
    h.human({ action: "click", point: { x: 10, y: 10 } });
    h.t += 5;
    const ev = h.obs({ type: "click", point: { x: 10, y: 10 }, target: CONTINUE })!;
    assert.equal(ev.actor, "human");
    assert.equal(ev.certainty, "inferred");
  });

  it("3. a page changing itself is not assigned to the user", () => {
    const h = new Harness();
    const m = h.obs({ type: "mutation", details: { added: 2, removed: 1, text: 0, attrs: 0 } })!;
    assert.equal(m.actor, "page");
    assert.equal(m.certainty, "inferred");
    const synthetic = h.obs({ type: "click", trusted: false, target: CONTINUE })!;
    assert.equal(synthetic.actor, "page");
    assert.notEqual(synthetic.certainty, "confirmed");

    // With other input paths possible, an unexplained change is not even called page-initiated.
    const h2 = new Harness();
    h2.coverage = "limited";
    assert.equal(h2.obs({ type: "mutation", details: { added: 1 } })!.actor, "unknown");
  });

  it("4. a failed AI command is not credited with later activity", () => {
    const h = new Harness();
    const id = h.engine.beginCommand({ agentId: "agent-1", action: "click", tabId: "tab-1", target: CONTINUE });
    h.t += 100;
    h.engine.endCommand(id, "failed", new Error("Timeout 30000ms exceeded"));
    h.t += 20;
    const ev = h.obs({ type: "click", point: { x: 1, y: 1 }, target: CONTINUE })!;
    assert.equal(ev.actor, "unknown");
    const cmds = h.ofKind("command");
    assert.deepEqual(cmds.map((c) => (c.details as { status: string }).status), ["started", "failed"]);
    assert.match(String((cmds[1].details as { error: string }).error), /Timeout/);
  });

  it("4b. a weak AI attribution is downgraded if the command later fails", () => {
    const h = new Harness();
    const id = h.engine.beginCommand({ agentId: "agent-1", action: "click", tabId: "tab-1" });
    const ev = h.obs({ type: "click", point: { x: 5, y: 5 }, target: CONTINUE })!;
    assert.equal(ev.actor, "ai");
    assert.equal(ev.certainty, "inferred");
    h.engine.endCommand(id, "cancelled");
    const upd = h.ofKind("attribution_update");
    assert.equal(upd.length, 1);
    assert.equal((upd[0].details as { updates: string }).updates, ev.eventId);
  });

  it("5. navigation creates a new document id and is recorded apart from the click that caused it", () => {
    const h = new Harness();
    h.human({ action: "click", point: { x: 50, y: 60 } });
    h.t += 5;
    const click = h.obs({ type: "click", point: { x: 50, y: 60 }, target: CONTINUE, documentId: "doc-1" })!;
    h.t += 200;
    const nav = h.obs({ type: "navigation", documentId: "doc-2", details: { kind: "new_document", url: "https://example.test/step2" } })!;
    assert.equal(click.kind, "input");
    assert.equal(click.actor, "human");
    assert.equal(nav.kind, "navigation");
    assert.notEqual(nav.documentId, click.documentId);
    assert.equal(nav.causedBy, click.eventId);
    assert.equal(nav.actor, "page"); // the page changed; ownership of the click is not transferred
    const link = nav.evidence.find((e) => e.type === "causal_link");
    assert.ok(link && link.type === "causal_link" && link.initiatedBy.actor === "human");
  });

  it("5b. an AI goto is confirmed by URL match", () => {
    const h = new Harness();
    h.engine.beginCommand({ agentId: "agent-1", action: "goto", tabId: "tab-1", url: "https://example.test/a" });
    const nav = h.obs({ type: "navigation", details: { kind: "new_document", url: "https://example.test/a#x" } })!;
    assert.equal(nav.actor, "ai");
    assert.equal(nav.certainty, "confirmed");
  });

  it("6. replay restores retained events and reports an unrecoverable gap", () => {
    const log = new EventLog("s", 5);
    for (let i = 0; i < 8; i++) {
      log.append({ observedAt: new Date().toISOString(), kind: "input", action: "click", actor: "human", certainty: "confirmed", evidence: [], relatedActionIds: [] });
    }
    const r = log.since(0);
    assert.deepEqual(r.gap, { fromSequence: 1, toSequence: 3, lost: 3 });
    assert.deepEqual(r.events.map((e) => e.sequence), [4, 5, 6, 7, 8]);

    const resumed: number[] = [];
    let gapSeen = false;
    log.subscribe((e) => resumed.push(e.sequence), { fromSequence: 6, onGap: () => (gapSeen = true) });
    assert.deepEqual(resumed, [7, 8]);
    assert.equal(gapSeen, false);

    const feed = new ContextFeed(log, 0);
    const u = feed.next();
    assert.equal(u.stale, true);
    assert.match(u.summary, /stale/i);
    feed.markRefreshed();
    assert.equal(feed.next().stale, false);
  });

  it("6b. disconnect marks context stale until the host refreshes", () => {
    const log = new EventLog("s", 50);
    const feed = new ContextFeed(log, 0);
    feed.markDisconnected();
    assert.equal(feed.peek().stale, true);
    feed.markRefreshed();
    assert.equal(feed.peek().stale, false);
  });

  it("7. uninstrumented input reports limited coverage and is never labelled human", async () => {
    const { trace, browser } = await attachFakes();
    assert.equal(trace.capabilities().humanInput.coverage, "full");
    browser.sink!.observe({ msgId: "x1", type: "click", at: Date.now(), tabId: "tab-1", trusted: true, target: CONTINUE, point: { x: 3, y: 3 } });
    const events = trace.log.since(0).events;
    const click = events.find((e) => e.kind === "input")!;
    assert.equal(click.actor, "unknown");
    assert.equal(trace.capabilities().humanInput.coverage, "limited");
    const cap = events.find((e) => e.kind === "capability_change");
    assert.ok(cap);
    assert.equal((cap!.details as { degraded: boolean }).degraded, true);
  });

  it("8. a password edit records the occurrence without exposing the value", () => {
    const h = new Harness();
    h.human({ action: "edit", target: { role: "textbox", label: "Password", inputType: "password", sensitive: true }, keyboard: true });
    h.t += 5;
    const ev = h.obs({
      type: "edit",
      target: { role: "textbox", label: "Password for jane@example.com", inputType: "password", sensitive: true },
      details: { count: 7, lastAt: h.t, value: "hunter2", text: "hunter2" },
    })!;
    const json = JSON.stringify(ev);
    assert.ok(!json.includes("hunter2"));
    assert.ok(!json.includes("jane@example.com"));
    assert.equal((ev.details as { edited: boolean }).edited, true);
    assert.equal((ev.details as { sensitive: boolean }).sensitive, true);
    assert.equal(ev.actor, "human");
  });
});

describe("trust boundaries", () => {
  it("page-provided fields cannot assign an actor", () => {
    const h = new Harness();
    const forged = { msgId: "f1", type: "click", at: h.t, tabId: "tab-1", trusted: true, actor: "human", certainty: "confirmed", evidence: [{ type: "human_channel" }], details: { actor: "human" } } as unknown as BrowserObservation;
    const ev = h.engine.ingest(forged)!;
    assert.equal(ev.actor, "unknown");
    assert.equal(ev.certainty, "unknown");
    assert.deepEqual(ev.evidence.map((e) => e.type).sort(), ["browser_event", "no_matching_source"]);
  });

  it("duplicate observations are ignored", () => {
    const h = new Harness();
    const o = { msgId: "dup", type: "mutation" as const, at: h.t, tabId: "tab-1", details: { added: 1 } };
    h.engine.ingest(o);
    h.engine.ingest(o);
    assert.equal(h.ofKind("observation").length, 1);
  });

  it("stopping observation drops browser events but keeps command records", () => {
    const h = new Harness();
    h.engine.setObserving(false);
    h.engine.beginCommand({ agentId: "a", action: "click", tabId: "tab-1" });
    assert.equal(h.obs({ type: "click", target: CONTINUE }), undefined);
    assert.equal(h.ofKind("command").length, 1);
  });

  it("different tabs never explain each other (switching tabs does not retarget the AI)", () => {
    const h = new Harness();
    h.engine.beginCommand({ agentId: "a", action: "click", tabId: "tab-1", target: CONTINUE });
    const ev = h.obs({ type: "click", tabId: "tab-2", target: CONTINUE, point: { x: 1, y: 1 } })!;
    assert.equal(ev.actor, "unknown");
    h.human({ action: "switch_tab", tabId: "tab-2" });
    const sw = h.ofKind("input").find((e) => e.action === "switch_tab")!;
    assert.equal(sw.actor, "human");
    assert.equal(sw.certainty, "confirmed");
  });
});

describe("ActionTrace facade", () => {
  it("records a command before dispatch and distinguishes completed from failed", async () => {
    const { trace } = await attachFakes();
    let startedBeforeDispatch = false;
    await trace.runAIAction({ agentId: "a1", action: "click", tabId: "tab-1" }, async () => {
      startedBeforeDispatch = trace.log.since(0).events.some((e) => e.kind === "command" && (e.details as { status: string }).status === "started");
    });
    assert.equal(startedBeforeDispatch, true);

    await assert.rejects(() => trace.runAIAction({ agentId: "a1", action: "fill", tabId: "tab-1" }, async () => { throw new Error("boom"); }), /boom/);
    const ac = new AbortController();
    await assert.rejects(() =>
      trace.runAIAction({ agentId: "a1", action: "click", signal: ac.signal }, async () => {
        ac.abort();
        throw new Error("aborted");
      }),
    );
    const statuses = trace.log.since(0).events.filter((e) => e.kind === "command").map((e) => (e.details as { status: string }).status);
    assert.deepEqual(statuses, ["started", "completed", "started", "failed", "started", "cancelled"]);
  });

  it("without a human channel, coverage is reported as none", async () => {
    const browser = new FakeBrowser();
    const trace = await ActionTrace.attach({ browserAdapter: browser });
    assert.equal(trace.capabilities().humanInput.coverage, "none");
  });

  it("context updates tell the AI that the user intervened", async () => {
    const { trace, browser, human } = await attachFakes();
    const feed = trace.contextFeed();
    human.sink!.recordIntent({ intentId: "i1", channelId: "viewer-1", action: "click", at: Date.now(), tabId: "tab-1", point: { x: 9, y: 9 } });
    browser.sink!.observe({ msgId: "c1", type: "click", at: Date.now(), tabId: "tab-1", trusted: true, point: { x: 9, y: 9 }, target: { role: "radio", label: "Pro plan" } });
    const u = feed.next();
    assert.match(u.summary, /user interacted/i);
    assert.match(u.summary, /HUMAN\(confirmed\) click radio "Pro plan"/);
    assert.equal(u.counts.human, 1);
    assert.equal(feed.next().eventCount, 0);
  });
});

// ---------------------------------------------------------------------- fakes

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
class FakeHuman implements HumanInputAdapter {
  name = "fake-viewer";
  channelId = "viewer-1";
  sink?: HumanIntentSink;
  coverage(): Coverage {
    return "full";
  }
  async start(s: HumanIntentSink) {
    this.sink = s;
  }
  async stop() {}
}
async function attachFakes() {
  const browser = new FakeBrowser();
  const human = new FakeHuman();
  const trace = await ActionTrace.attach({ browserAdapter: browser, humanInputAdapter: human });
  return { trace, browser, human };
}
