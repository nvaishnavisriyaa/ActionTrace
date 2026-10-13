/**
 * An "existing AI tool" that drives its own Playwright connection, integrated without changing how
 * it drives the browser: it only brackets each action with AgentClient and reads TraceClient.
 *
 *   actiontrace serve --url http://localhost:3000 --cdp-port 9222 > session.json
 *   node dist/examples/external-agent.js session.json
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { AgentClient, TraceClient } from "../src/index.js";

const info = JSON.parse(readFileSync(process.argv[2] ?? "session.json", "utf8"));
const common = { url: info.url as string, sessionId: info.sessionId as string };
const reader = new TraceClient({ ...common, token: info.tokens.consumer });
const agent = new AgentClient({ ...common, token: info.tokens.agent });

const browser = await chromium.connectOverCDP(info.cdpEndpoint);
const page = browser.contexts()[0].pages()[0];
const [tab] = await reader.tabs();

// "What changed since I last looked?" is asked at each model step.
let cursor = (await reader.capabilities()).stream.lastSequence;
const lookAround = async () => {
  const update = await reader.context(cursor);
  cursor = update.toSequence;
  return update;
};

// Each browser action is registered before it is dispatched.
await agent.run(
  { agentId: "my-tool", action: "click", tabId: tab.tabId, target: { role: "button", label: "Continue" } },
  () => page.getByRole("button", { name: "Continue" }).click(),
);

const update = await lookAround();
console.log(update.summary); // goes into the model's next prompt
if (update.humanTouched.length) console.log("The user changed:", update.humanTouched);

await browser.close();
