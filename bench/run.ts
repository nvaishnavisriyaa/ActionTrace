/**
 * Attribution benchmark against a real browser, with ground truth known by construction.
 *
 *   npm run bench            # 120 trials by default; TRIALS=300 for more
 *
 * Reports precision of "confirmed" labels and coverage of supported input actions TOGETHER,
 * because labelling everything "unknown" would otherwise look accurate.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { ActionTrace, PlaywrightAdapter, PlaywrightAgentActions, ViewerAdapter, type Actor, type TraceEvent } from "../src/index.js";

const siteDir = fileURLToPath(new URL("../../demo/site/", import.meta.url));
const TRIALS = Number(process.env.TRIALS ?? 120);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Deterministic PRNG so runs are comparable.
let seed = Number(process.env.SEED ?? 42);
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

type Expect = { action: string; label: string; actor: Actor | "ambiguous" };
type Trial = { name: string; expect: Expect[]; run: () => Promise<void> };

async function main() {
  const site = createServer((req, res) => {
    let body: Buffer | undefined;
    try {
      body = readFileSync(siteDir + ((req.url ?? "/").split("?")[0].replace(/^\//, "") || "index.html").replace(/[^\w.]/g, ""));
    } catch {
      /* not found */
    }
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(body);
  });
  await new Promise<void>((ok) => site.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/index.html`;

  const browser = await chromium.launch({ channel: process.env.BROWSER ?? "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1024, height: 640 } });
  const page = await context.newPage();
  const pw = new PlaywrightAdapter(context);
  const viewer = new ViewerAdapter(pw);
  const trace = await ActionTrace.attach({ browserAdapter: pw, humanInputAdapter: viewer, sessionId: "bench" });
  const ai = new PlaywrightAgentActions(trace, pw, "agent-1", page);
  await ai.goto(url);
  await page.waitForLoadState("domcontentloaded");
  await sleep(300);

  const center = async (sel: string) => {
    const b = (await page.locator(sel).boundingBox())!;
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  };
  const humanClick = async (sel: string) => viewer.handle({ type: "click", ...(await center(sel)) });
  const humanType = async (sel: string, text: string) => {
    await humanClick(sel);
    await sleep(120);
    for (const ch of text) await viewer.handle({ type: "key", key: ch });
  };
  let scrollDir = 1;
  const humanScroll = async (dy: number) => {
    await viewer.handle({ type: "scroll", x: 500, y: 300, dx: 0, dy: dy * scrollDir });
    scrollDir *= -1;
  };

  const trials: Trial[] = [
    { name: "ai click checkbox", expect: [{ action: "click", label: "Send me product news", actor: "ai" }], run: () => ai.click(page.getByLabel("Send me product news")) },
    { name: "ai fill name", expect: [{ action: "edit", label: "Full name", actor: "ai" }], run: () => ai.fill(page.getByLabel("Full name"), "Ada " + Math.floor(rnd() * 1000)) },
    { name: "ai click plan", expect: [{ action: "click", label: "Basic plan", actor: "ai" }], run: () => ai.click(page.getByLabel("Basic plan")) },
    { name: "human click plan", expect: [{ action: "click", label: "Pro plan", actor: "human" }], run: () => humanClick("#plan-pro") },
    { name: "human click reset", expect: [{ action: "click", label: "Reset", actor: "human" }], run: () => humanClick("#reset") },
    { name: "human type email", expect: [{ action: "edit", label: "Email", actor: "human" }], run: () => humanType("#email", "abc") },
    { name: "human scroll", expect: [{ action: "scroll", label: "page", actor: "human" }], run: () => humanScroll(150) },
    {
      name: "overlap: AI fill name + human click plan (different elements)",
      expect: [
        { action: "edit", label: "Full name", actor: "ai" },
        { action: "click", label: "Pro plan", actor: "human" },
      ],
      run: async () => {
        await Promise.all([ai.fill(page.getByLabel("Full name"), "Grace " + Math.floor(rnd() * 1000)), humanClick("#plan-pro")]);
      },
    },
    {
      name: "overlap: AI click + human scroll",
      expect: [
        { action: "click", label: "Send me product news", actor: "ai" },
        { action: "scroll", label: "page", actor: "human" },
      ],
      run: async () => {
        await Promise.all([ai.click(page.getByLabel("Send me product news")), humanScroll(120)]);
      },
    },
    {
      name: "same element, same time: AI click + human click (must not be confirmed)",
      expect: [
        { action: "click", label: "Send me product news", actor: "ambiguous" },
        { action: "click", label: "Send me product news", actor: "ambiguous" },
      ],
      run: async () => {
        await Promise.all([ai.click(page.getByLabel("Send me product news")), humanClick("#news")]);
      },
    },
  ];
  // Weighted so single-actor trials dominate, as in real use.
  const weights = [3, 3, 2, 3, 2, 3, 2, 2, 2, 2];
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let supported = 0, attributed = 0, confirmed = 0, confirmedCorrect = 0, missed = 0;
  let ambiguousTotal = 0, ambiguousWronglyConfirmed = 0, ambiguousLeftUncertain = 0;
  const failures: string[] = [];
  const uncertain: string[] = [];

  for (let i = 0; i < TRIALS; i++) {
    let r = rnd() * totalWeight;
    let k = 0;
    while (k < weights.length - 1 && (r -= weights[k]) > 0) k++;
    const t = trials[k];
    const before = trace.log.lastSequence;
    try {
      await t.run();
    } catch (e) {
      failures.push(`${t.name}: ${(e as Error).message.split("\n")[0]}`);
    }
    await sleep(350); // let batched edits and scrolls flush
    const events = trace.log.since(before).events.filter((e: TraceEvent) => e.kind === "input" && e.action !== "switch_tab");
    const used = new Set<string>();
    for (const ex of t.expect) {
      const ev = events.find((e) => !used.has(e.eventId) && e.action === ex.action && (e.target?.label ?? "").toLowerCase().includes(ex.label.toLowerCase()));
      if (ev) used.add(ev.eventId);
      if (ex.actor === "ambiguous") {
        ambiguousTotal++;
        if (!ev) continue;
        if (ev.certainty === "confirmed") {
          ambiguousWronglyConfirmed++;
          failures.push(`${t.name}: confirmed ${ev.actor}`);
        } else ambiguousLeftUncertain++;
        continue;
      }
      supported++;
      if (!ev) {
        missed++;
        failures.push(`${t.name}: no event observed for ${ex.action} ${ex.label}`);
        continue;
      }
      if (ev.actor !== "unknown" && ev.certainty !== "unknown") attributed++;
      else uncertain.push(`${t.name}: ${ex.action} ${ex.label} left ${ev.actor}/${ev.certainty} (${ev.evidence.map((e) => e.type).join(", ")})`);
      if (ev.certainty === "confirmed") {
        confirmed++;
        if (ev.actor === ex.actor) confirmedCorrect++;
        else failures.push(`${t.name}: confirmed ${ev.actor}, expected ${ex.actor}`);
      }
    }
  }

  const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + "%" : "n/a");
  console.log(`\nActionTrace attribution benchmark (${TRIALS} trials, real Chrome)\n`);
  console.log(`  Supported input actions:            ${supported}`);
  console.log(`  Coverage (attributed, not unknown): ${attributed}/${supported} = ${pct(attributed, supported)}   target >= 95%`);
  console.log(`  Precision of "confirmed":           ${confirmedCorrect}/${confirmed} = ${pct(confirmedCorrect, confirmed)}   target >= 99%`);
  console.log(`  Missed observations:                ${missed}`);
  console.log(`  Same-element simultaneous cases:    ${ambiguousTotal}; wrongly confirmed: ${ambiguousWronglyConfirmed}; left uncertain: ${ambiguousLeftUncertain}`);
  const l = trace.capabilities().stream.latencyMs;
  console.log(`  Capture-to-controller latency:      p50 ${l.p50} ms, p95 ${l.p95} ms (n=${l.samples})   target p95 < 100 ms`);
  if (uncertain.length) {
    console.log("\n  Supported actions left uncertain (conservative, not wrong):\n   - " + [...new Set(uncertain)].slice(0, 10).join("\n   - "));
  }
  if (failures.length) console.log("\n  Failures:\n   - " + [...new Set(failures)].slice(0, 15).join("\n   - "));
  console.log();

  await browser.close();
  site.close();
  const ok = confirmed > 0 && confirmedCorrect === confirmed && ambiguousWronglyConfirmed === 0 && attributed / Math.max(1, supported) >= 0.95;
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
