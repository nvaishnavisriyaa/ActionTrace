/**
 * The three-step integration, end to end, with no demo scaffolding.
 *
 *   1. Attach the browser observer.
 *   2. Route AI commands (and the supported human channel) through adapters.
 *   3. Subscribe the AI controller to the resulting events.
 *
 * Run:  npm run build && node dist/examples/integrate.js
 */
import { chromium } from "playwright-core";
import { ActionTrace, PlaywrightAdapter, PlaywrightAgentActions, ViewerAdapter } from "../src/index.js";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext();
const page = await context.newPage();
await page.setContent(`<button onclick="document.title='clicked'">Continue</button><input aria-label="Name">`);

// 1 + 2: observer + human channel (the viewer is optional; without it human input stays "unknown").
const pw = new PlaywrightAdapter(context);
const trace = await ActionTrace.attach({
  browserAdapter: pw,
  humanInputAdapter: new ViewerAdapter(pw),
});

// 3: the controller consumes the stream continuously...
const queue: string[] = [];
trace.subscribe((e) => queue.push(`#${e.sequence} ${e.actor}(${e.certainty}) ${e.kind}:${e.action}`));

// ...and injects "what changed since my last observation" at the model's next execution boundary.
const feed = trace.contextFeed();

// AI commands go through ActionTrace so they are recorded before dispatch.
const ai = new PlaywrightAgentActions(trace, pw, "agent-1", page);
await ai.fill(page.getByLabel("Name"), "Ada");
await ai.click(page.getByRole("button", { name: "Continue" }));
await new Promise((r) => setTimeout(r, 250));

console.log(queue.join("\n"));
console.log("\n--- what the model would be told ---\n" + feed.next().summary);
console.log("\n--- capabilities ---\n" + JSON.stringify(trace.capabilities(), null, 2));

await browser.close();
