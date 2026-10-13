import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { ActionTrace } from "../src/actiontrace.js";
import { PlaywrightAdapter, PlaywrightAgentActions } from "../src/adapters/playwright.js";
import { ViewerAdapter } from "../src/adapters/viewer.js";
import type { TraceEvent } from "../src/protocol.js";

const siteDir = fileURLToPath(new URL("../../demo/site/", import.meta.url));

let site: Server;
let base = "";
let browser: Browser | undefined;
let context: BrowserContext;
let page: Page;
let pw: PlaywrightAdapter;
let viewer: ViewerAdapter;
let trace: ActionTrace;
let agent: PlaywrightAgentActions;
let skip: string | false = false;

const waitFor = async <T>(fn: () => T | undefined | false, ms = 4000, what = "condition"): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const events = () => trace.log.since(0).events;
const find = (p: (e: TraceEvent) => boolean) => events().find(p);
const center = async (sel: string) => {
  const b = (await page.locator(sel).boundingBox())!;
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
};

before(async () => {
  site = createServer((req, res) => {
    const name = (req.url ?? "/").split("?")[0].replace(/^\//, "") || "index.html";
    let body: Buffer | undefined;
    try {
      body = readFileSync(siteDir + name.replace(/[^\w.]/g, ""));
    } catch {
      /* not found, e.g. /favicon.ico */
    }
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(body);
  });
  await new Promise<void>((ok) => site.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch (err) {
    try {
      browser = await chromium.launch({ channel: "msedge", headless: true });
    } catch {
      skip = "no Chrome/Edge available: " + (err as Error).message.split("\n")[0];
      return;
    }
  }
  context = await browser.newContext({ viewport: { width: 1024, height: 640 } });
  page = await context.newPage();
  pw = new PlaywrightAdapter(context);
  viewer = new ViewerAdapter(pw, { exclusive: true });
  trace = await ActionTrace.attach({ browserAdapter: pw, humanInputAdapter: viewer, sessionId: "e2e" });
  agent = new PlaywrightAgentActions(trace, pw, "agent-1", page);
  await agent.goto(base + "/index.html");
  await page.waitForLoadState("domcontentloaded");
});

after(async () => {
  await browser?.close();
  site.close();
});

describe("real browser (Playwright + viewer channel)", () => {
  it("records the AI's goto as confirmed and a new document id", async (t) => {
    if (skip) return t.skip(skip);
    const nav = await waitFor(() => find((e) => e.kind === "navigation" && e.actor === "ai"), 4000, "AI navigation");
    assert.equal(nav.certainty, "confirmed");
    assert.ok(nav.documentId);
    assert.ok(nav.tabId);
  });

  it("AI fill is attributed to the AI (confirmed, target verified)", async (t) => {
    if (skip) return t.skip(skip);
    await agent.fill(page.getByLabel("Full name"), "Ada Lovelace");
    const e = await waitFor(() => find((x) => x.kind === "input" && x.action === "edit" && !!x.target?.label?.startsWith("Full name")), 4000, "AI edit");
    assert.equal(e.actor, "ai");
    assert.equal(e.certainty, "confirmed");
    assert.ok(!JSON.stringify(e).includes("Ada"), "typed text must not appear in the event");
  });

  it("a human click through the viewer is confirmed human, by pointer position", async (t) => {
    if (skip) return t.skip(skip);
    const before = events().length;
    const p = await center("#plan-pro");
    await viewer.handle({ type: "click", ...p });
    const e = await waitFor(() => events().slice(before).find((x) => x.kind === "input" && x.action === "click"), 4000, "human click");
    assert.equal(e.actor, "human");
    assert.equal(e.certainty, "confirmed");
    assert.equal(e.target?.role, "radio");
    assert.ok(e.evidence.some((x) => x.type === "human_channel" && x.channelId === "viewer-1"));
    assert.equal(await page.locator("#plan-pro").isChecked(), true);
  });

  it("human typing through the viewer is a confirmed human edit; the typed text is never recorded", async (t) => {
    if (skip) return t.skip(skip);
    const before = events().length;
    await viewer.handle({ type: "click", ...(await center("#email")) });
    for (const ch of "secret@x.io") await viewer.handle({ type: "key", key: ch });
    const e = await waitFor(() => events().slice(before).find((x) => x.kind === "input" && x.action === "edit"), 4000, "human edit");
    assert.equal(e.actor, "human");
    assert.equal(e.certainty, "confirmed");
    assert.equal(await page.locator("#email").inputValue(), "secret@x.io");
    assert.ok(!JSON.stringify(events().slice(before)).includes("secret@x.io"));
  });

  it("a password edit by the AI records the occurrence only", async (t) => {
    if (skip) return t.skip(skip);
    const before = events().length;
    await agent.fill(page.getByLabel("Password"), "hunter2-correct-horse");
    const e = await waitFor(() => events().slice(before).find((x) => x.kind === "input" && x.action === "edit"), 4000, "password edit");
    assert.equal(e.actor, "ai");
    assert.equal((e.details as { sensitive?: boolean }).sensitive, true);
    assert.ok(!JSON.stringify(events().slice(before)).includes("hunter2"));
  });

  it("human scroll is attributed to the human while an AI command is in flight", async (t) => {
    if (skip) return t.skip(skip);
    const before = events().length;
    const slow = trace.runAIAction({ agentId: "agent-1", action: "click", tabId: pw.tabId(page), target: { role: "checkbox", label: "Send me product news" } }, async () => {
      await new Promise((r) => setTimeout(r, 300));
      await page.locator("#news").click();
    });
    await viewer.handle({ type: "scroll", x: 500, y: 300, dx: 0, dy: 200 });
    await slow;
    const scroll = await waitFor(() => events().slice(before).find((x) => x.action === "scroll"), 4000, "scroll");
    const click = await waitFor(() => events().slice(before).find((x) => x.action === "click" && x.kind === "input"), 4000, "AI click");
    assert.equal(scroll.actor, "human");
    assert.equal(scroll.certainty, "confirmed");
    assert.equal(click.actor, "ai");
    assert.equal(click.certainty, "confirmed");
  });

  it("the page's own timer is a page change, not human or AI", async (t) => {
    if (skip) return t.skip(skip);
    const m = await waitFor(() => events().find((x) => x.action === "mutation" && !x.causedBy), 6000, "page mutation");
    assert.equal(m.actor, "page");
    assert.equal(m.certainty, "inferred");
  });

  it("a script-dispatched click is not credited to anyone but the page", async (t) => {
    if (skip) return t.skip(skip);
    const before = events().length;
    await page.evaluate(() => (document.getElementById("reset") as HTMLButtonElement).click());
    const e = await waitFor(() => events().slice(before).find((x) => x.action === "click"), 4000, "synthetic click");
    assert.equal(e.actor, "page");
    assert.notEqual(e.certainty, "confirmed");
  });

  it("input through an uninstrumented path stays unknown and degrades coverage", async (t) => {
    if (skip) return t.skip(skip);
    assert.equal(trace.capabilities().humanInput.coverage, "full");
    const before = events().length;
    await page.mouse.click(...(Object.values(await center("#plan-basic")) as [number, number])); // bypasses runAIAction and the viewer
    const e = await waitFor(() => events().slice(before).find((x) => x.kind === "input" && x.action === "click"), 4000, "uninstrumented click");
    assert.equal(e.actor, "unknown");
    assert.equal(trace.capabilities().humanInput.coverage, "limited");
    assert.ok(events().some((x) => x.kind === "capability_change"));
  });

  it("navigation caused by a click is a separate record, linked but not owned by the click", async (t) => {
    if (skip) return t.skip(skip);
    const before = events().length;
    await agent.click(page.getByRole("button", { name: "Continue" }));
    const click = await waitFor(() => events().slice(before).find((x) => x.kind === "input" && x.action === "click"), 4000, "Continue click");
    const nav = await waitFor(() => events().slice(before).find((x) => x.kind === "navigation"), 5000, "navigation");
    assert.equal(click.actor, "ai");
    assert.equal(nav.causedBy, click.eventId);
    assert.equal(nav.actor, "page");
    assert.notEqual(nav.documentId, click.documentId, "observation resumed with a new document id");
    // And the new document is observed too.
    const before2 = events().length;
    await agent.click(page.getByRole("link", { name: "Back to the form" }));
    await waitFor(() => events().slice(before2).find((x) => x.kind === "input" && x.target?.label === "Back to the form"), 4000, "click on new document");
  });

  it("new tabs get their own ids; the human switching the viewed tab does not retarget the AI", async (t) => {
    if (skip) return t.skip(skip);
    const before = events().length;
    const tab1 = pw.tabId(page);
    const page2 = await trace.runAIAction({ agentId: "agent-1", action: "open_tab" }, () => context.newPage());
    await new PlaywrightAgentActions(trace, pw, "agent-1", page2).goto(base + "/step2.html");
    const opened = await waitFor(() => events().slice(before).find((e) => e.action === "tab_opened"), 4000, "tab_opened");
    assert.notEqual(opened.tabId, tab1);
    assert.equal(opened.actor, "ai");
    assert.notEqual(opened.certainty, "unknown");

    await viewer.handle({ type: "switch_tab", tabId: opened.tabId! });
    const sw = await waitFor(() => events().slice(before).find((e) => e.action === "switch_tab"), 4000, "switch_tab");
    assert.equal(sw.actor, "human");
    assert.equal(sw.certainty, "confirmed");

    const link = (await page2.getByRole("link", { name: "Back to the form" }).boundingBox())!;
    await viewer.handle({ type: "click", x: Math.round(link.x + link.width / 2), y: Math.round(link.y + link.height / 2) });
    const hc = await waitFor(() => events().slice(before).find((e) => e.action === "click" && e.kind === "input" && e.tabId === opened.tabId), 4000, "human click in tab 2");
    assert.equal(hc.actor, "human");
    assert.equal(hc.certainty, "confirmed");

    // The viewer now shows tab 2, but the AI's command still targets tab 1 and is attributed there.
    const before2 = events().length;
    await agent.click(page.getByLabel("Send me product news"));
    const ac = await waitFor(() => events().slice(before2).find((e) => e.action === "click" && e.kind === "input"), 4000, "AI click in tab 1");
    assert.equal(ac.tabId, tab1);
    assert.equal(ac.actor, "ai");
    assert.equal(ac.certainty, "confirmed");
    await page2.close();
  });

  it("reports capabilities and capture-to-controller latency", async (t) => {
    if (skip) return t.skip(skip);
    const c = trace.capabilities();
    assert.equal(c.observer.navigation, true);
    assert.ok(c.stream.latencyMs.samples > 5);
    console.log(`      latency p50=${c.stream.latencyMs.p50}ms p95=${c.stream.latencyMs.p95}ms (n=${c.stream.latencyMs.samples})`);
  });
});
