import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ContextFeed, findPeriodicUpdates, summarizeEvents } from "../src/context.js";
import type { Actor, Certainty, TraceEvent } from "../src/protocol.js";

let seq = 0;
const t0 = Date.parse("2026-10-13T12:00:00.000Z");
const ev = (over: Partial<TraceEvent> & { at: number }): TraceEvent => {
  const { at, ...rest } = over;
  seq++;
  return {
    schemaVersion: "1.0",
    sessionId: "s",
    eventId: `event-${seq}`,
    sequence: seq,
    observedAt: new Date(t0 + at).toISOString(),
    kind: "observation",
    action: "mutation",
    actor: "page",
    certainty: "inferred",
    tabId: "tab-1",
    target: { tag: "span", label: "count" },
    evidence: [],
    relatedActionIds: [],
    ...rest,
  };
};
const ticks = (n: number, gap: number, start = 0, actor: Actor = "page", certainty: Certainty = "inferred") =>
  Array.from({ length: n }, (_, i) => ev({ at: start + i * gap, actor, certainty }));

describe("periodic background updates", () => {
  it("a regular ticker becomes one background line, not dozens of event lines", () => {
    const events = ticks(30, 2000);
    const s = summarizeEvents(events);
    assert.equal(s.lines.length, 0);
    assert.equal(s.background.length, 1);
    assert.match(s.background[0], /updated 30× roughly every 2s/);
    assert.match(s.background[0], /not caused by input/);
    assert.match(s.summary, /BACKGROUND:/);
    assert.match(s.summary, /besides background updates/);
    assert.equal(s.eventCount, 30, "nothing is discarded from the counts");
  });

  it("is found even when the engine labels some ticks page and some unknown", () => {
    const events = [...ticks(4, 2000, 0, "page", "inferred"), ...ticks(4, 2000, 8000, "unknown", "unknown")];
    assert.equal(summarizeEvents(events).background.length, 1);
  });

  it("does not hide real input that happens between ticks", () => {
    const click = ev({ at: 5000, kind: "input", action: "click", actor: "human", certainty: "confirmed", target: { role: "radio", label: "Pro plan" } });
    const s = summarizeEvents([...ticks(3, 2000), click, ...ticks(4, 2000, 6000)]);
    assert.ok(s.lines.some((l) => /HUMAN\(confirmed\) click radio "Pro plan"/.test(l)));
    assert.equal(s.humanTouched.length, 1);
  });

  it("leaves irregular updates alone", () => {
    const gaps = [100, 4000, 300, 9000, 150, 2500, 40];
    let at = 0;
    const events = [ev({ at })].concat(gaps.map((g) => ev({ at: (at += g) })));
    const { periodic } = findPeriodicUpdates(events);
    assert.equal(periodic.size, 0);
  });

  it("leaves short runs and rapid bursts alone", () => {
    assert.equal(findPeriodicUpdates(ticks(3, 2000)).periodic.size, 0, "needs 4 occurrences");
    assert.equal(findPeriodicUpdates(ticks(20, 50)).periodic.size, 0, "a 50ms burst is not a ticker");
  });

  it("never treats a page change caused by input as background", () => {
    const events = ticks(6, 2000).map((e) => ({ ...e, causedBy: "event-click" }));
    const s = summarizeEvents(events);
    assert.equal(s.background.length, 0);
    assert.ok(s.lines.length > 0);
  });

  it("keeps different targets separate", () => {
    const other = Array.from({ length: 5 }, (_, i) => ev({ at: i * 2000, target: { tag: "div", label: "banner" } }));
    const s = summarizeEvents([...ticks(5, 2000), ...other]);
    assert.equal(s.background.length, 2);
  });

  it("ContextFeed (the live path every actiontrace_changes / agent changes call goes through) also includes BACKGROUND", () => {
    // Regression: summarizeEvents() computed `background` correctly, but ContextFeed.build() used to
    // rebuild `summary` itself from `lines` only, silently dropping the BACKGROUND section in the one
    // text models actually read. A test that calls summarizeEvents() directly, as the others above do,
    // would never catch that.
    const events = ticks(30, 2000);
    const fakeLog = { since: () => ({ events }), lastSequence: events.at(-1)!.sequence };
    const feed = new ContextFeed(fakeLog as unknown as ConstructorParameters<typeof ContextFeed>[0], 0);
    const u = feed.peek();
    assert.equal(u.lines.length, 0);
    assert.match(u.summary, /BACKGROUND:/);
    assert.match(u.summary, /updated 30× roughly every 2s/);
    assert.match(u.summary, /No browser activity since your last observation besides background updates\./);
  });
});
