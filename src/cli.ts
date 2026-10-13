#!/usr/bin/env node
/**
 * actiontrace: run ActionTrace as a sidecar, for AI tools that are not written in TypeScript or
 * that you do not want to modify.
 *
 *   actiontrace serve --url https://example.com --cdp-port 9222
 *
 * It starts a Chromium-family browser (your installed Chrome or Edge), the attribution engine, the
 * event server and the human viewer, then prints connection details as JSON on stdout. Anything that
 * speaks Chrome DevTools Protocol (Playwright connectOverCDP, Puppeteer, browser-use, Playwright MCP
 * with --cdp-endpoint, ...) can then drive the same browser.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { ActionTrace } from "./actiontrace.js";
import { AGENT_HELP, agentMain } from "./agent-cli.js";
import { PlaywrightAdapter } from "./adapters/playwright.js";
import { ViewerAdapter } from "./adapters/viewer.js";
import { TraceServer, newToken } from "./server.js";

const HELP = `actiontrace serve [options]

  --url <url>         Page to open first.
  --demo              Serve the bundled demo site (a signup form) and open it. Ignores --url.
  --info-file <path>  Also write the connection details (including tokens) to this file, for
                      "actiontrace agent" and other local tools. Keep it out of version control.
  --port <n>          Port for the event server and viewer UI (default 4173; 0 = any free port).
  --cdp-port <n>      Also expose the browser on this DevTools port (127.0.0.1 only) so another tool can drive it.
  --session <id>      Session id (default "main").
  --browser <name>    Playwright channel: chrome (default), msedge, chrome-beta, ...
  --headed            Show a real browser window too. Human-input coverage is then reported as "limited".
  --no-ui             Do not serve the viewer / timeline UI.
  --exit-on-stdin-close  Shut down cleanly when stdin closes. For a parent process that spawns this
                      one with piped stdio; on Windows this is the portable way to stop it cleanly.
  --help

Tokens are generated per run. To keep them stable across restarts (e.g. in an MCP client config) set
ACTIONTRACE_CONSUMER_TOKEN, ACTIONTRACE_AGENT_TOKEN and ACTIONTRACE_HUMAN_TOKEN (16+ characters each).
`;

function tokenFromEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") return newToken();
  if (v.length < 16) {
    console.error(`actiontrace: ${name} must be at least 16 characters.`);
    process.exit(2);
  }
  return v;
}

async function serve(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      demo: { type: "boolean", default: false },
      "info-file": { type: "string" },
      port: { type: "string", default: "4173" },
      "cdp-port": { type: "string" },
      session: { type: "string", default: "main" },
      browser: { type: "string", default: "chrome" },
      headed: { type: "boolean", default: false },
      "no-ui": { type: "boolean", default: false },
      "exit-on-stdin-close": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return void console.log(HELP);

  const port = Number(values.port);
  const cdpPort = values["cdp-port"] === undefined ? undefined : Number(values["cdp-port"]);
  for (const [n, v] of [["--port", port], ["--cdp-port", cdpPort]] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 65535)) {
      console.error(`actiontrace: ${n} must be an integer between 0 and 65535.`);
      process.exit(2);
    }
  }
  if (values.url) {
    try {
      const u = new URL(values.url);
      if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "file:") throw new Error("scheme");
    } catch {
      console.error("actiontrace: --url must be an http(s) or file URL.");
      process.exit(2);
    }
  }

  let startUrl = values.url;
  let demoSite: Server | undefined;
  if (values.demo) {
    const dir = fileURLToPath(new URL("../../demo/site/", import.meta.url));
    demoSite = createServer((req, res) => {
      const name = ((req.url ?? "/").split("?")[0].replace(/^\//, "") || "index.html").replace(/[^\w.]/g, "");
      try {
        const body = readFileSync(dir + name);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    // A different origin from the control UI, so the automated page cannot reach the trace server.
    await new Promise<void>((ok) => demoSite!.listen(0, "127.0.0.1", ok));
    startUrl = `http://127.0.0.1:${(demoSite.address() as AddressInfo).port}/index.html`;
  }

  const sessionId = values.session!;
  const headed = values.headed!;
  // A fresh profile every run: nothing from the user's own browser profile is exposed to the tool.
  const profile = await mkdtemp(join(tmpdir(), "actiontrace-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: values.browser,
    headless: !headed,
    viewport: { width: 1280, height: 800 },
    args: cdpPort === undefined ? [] : [`--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  if (startUrl) await page.goto(startUrl); // before attaching: a page that was already open

  const pw = new PlaywrightAdapter(context);
  const viewer = new ViewerAdapter(pw, { exclusive: !headed });
  const trace = await ActionTrace.attach({ browserAdapter: pw, humanInputAdapter: viewer, sessionId });
  if (cdpPort !== undefined) {
    trace.declareAICoverage("limited", "An external tool drives this browser over DevTools. Its actions are attributed to the AI only if it registers them through the commands API.");
  }

  const consumerToken = tokenFromEnv("ACTIONTRACE_CONSUMER_TOKEN");
  const agentToken = tokenFromEnv("ACTIONTRACE_AGENT_TOKEN");
  const humanToken = tokenFromEnv("ACTIONTRACE_HUMAN_TOKEN");
  const uiDir = fileURLToPath(new URL("../../demo/public", import.meta.url));
  const server = new TraceServer({ port, staticDir: values["no-ui"] || !existsSync(uiDir) ? undefined : uiDir });
  server.addSession({ trace, consumerToken, humanToken, agentToken, viewer, tabs: () => pw.listTabs() });
  const { url } = await server.listen();

  const info = {
    url,
    sessionId,
    tokens: { consumer: consumerToken, agent: agentToken, human: humanToken },
    ui: values["no-ui"] ? undefined : `${url}/#sid=${encodeURIComponent(sessionId)}&ct=${consumerToken}&ht=${humanToken}`,
    cdpEndpoint: cdpPort === undefined ? undefined : `http://127.0.0.1:${cdpPort}`,
    mcp: { command: "actiontrace-mcp", env: { ACTIONTRACE_URL: url, ACTIONTRACE_SESSION: sessionId, ACTIONTRACE_TOKEN: consumerToken } },
  };
  if (values["info-file"]) writeFileSync(values["info-file"], JSON.stringify(info, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(info));
  console.error(
    [
      "",
      "ActionTrace is running. Connection details were printed to stdout as JSON.",
      info.ui ? `  Viewer + timeline : ${info.ui}` : "",
      info.cdpEndpoint ? `  DevTools endpoint : ${info.cdpEndpoint}   (any local process can control the browser through it)` : "  DevTools endpoint : off (use --cdp-port to let another tool drive this browser)",
      `  Human-input coverage: ${trace.capabilities().humanInput.coverage}`,
      "  Ctrl+C to stop.",
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => undefined);
    demoSite?.close();
    await trace.detach().catch(() => undefined);
    await context.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  context.on("close", () => void shutdown()); // the browser window was closed
  if (values["exit-on-stdin-close"]) {
    process.stdin.resume();
    process.stdin.on("end", () => void shutdown());
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "agent") {
  agentMain(rest).then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`actiontrace agent: ${err.message.split("\n")[0]}`);
      process.exit(1);
    },
  );
} else if (cmd === "serve") {
  serve(rest).catch((err: Error) => {
    console.error(`actiontrace: ${err.message.split("\n")[0]}`);
    process.exit(1);
  });
} else {
  console.log(HELP + "\n" + AGENT_HELP);
  process.exit(cmd === undefined || cmd === "--help" || cmd === "help" ? 0 : 2);
}
