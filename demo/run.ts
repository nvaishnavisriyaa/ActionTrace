/**
 * Shared-browser demo: a person (through the viewer) and a scripted AI agent drive one browser.
 *
 *   npm run demo                # headless browser, viewer is the only human path (coverage: full)
 *   $env:HEADED=1; npm run demo # visible browser window too (coverage: limited, reported honestly)
 *   $env:PORT=4173; $env:BROWSER=msedge
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { ActionTrace, PlaywrightAdapter, TraceServer, ViewerAdapter, newToken } from "../src/index.js";
import { send } from "../src/server.js";
import { DemoAgent } from "./agent.js";

const root = fileURLToPath(new URL("../../demo/", import.meta.url));
const headed = process.env.HEADED === "1";

async function startSite(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const name = ((req.url ?? "/").split("?")[0].replace(/^\//, "") || "index.html").replace(/[^\w.]/g, "");
    try {
      const body = await readFile(root + "site/" + name);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  // A separate origin from the control UI: the page being automated cannot reach the trace server.
  await new Promise<void>((ok) => server.listen(Number(process.env.SITE_PORT ?? 0), "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function main() {
  const site = await startSite();

  const browser = await chromium.launch({ channel: process.env.BROWSER ?? "chrome", headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1024, height: 640 } });
  const page = await context.newPage();

  const pw = new PlaywrightAdapter(context);
  const viewer = new ViewerAdapter(pw, { exclusive: !headed });
  const trace = await ActionTrace.attach({ browserAdapter: pw, humanInputAdapter: viewer, sessionId: "demo" });
  const agent = new DemoAgent(trace, pw, page, site.url);
  await page.goto(site.url + "/index.html"); // before the agent starts, like a page the user already had open

  const consumerToken = newToken();
  const humanToken = newToken();
  const server = new TraceServer({
    port: Number(process.env.PORT ?? 0),
    staticDir: root + "public",
    onRequest: async (req, res, srv) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (!url.pathname.startsWith("/api/demo/")) return false;
      if (!srv.authenticate(req, "demo")) return send(res, 401, { error: "unauthorized" }), true;
      if (url.pathname === "/api/demo/run" && req.method === "POST") {
        void agent.run();
        return send(res, 200, { running: true }), true;
      }
      if (url.pathname === "/api/demo/stop" && req.method === "POST") {
        agent.stop();
        return send(res, 200, { stopping: true }), true;
      }
      if (url.pathname === "/api/demo/agent-log") {
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        return send(res, 200, { running: agent.running, lines: agent.lines.filter((l) => l.n > since) }), true;
      }
      return false;
    },
  });
  server.addSession({ trace, consumerToken, humanToken, viewer });
  const { url } = await server.listen();

  console.log("\nActionTrace demo is running.\n");
  console.log("  Open this link (it carries this run's access tokens in the #fragment, which is never sent to a server):\n");
  console.log(`  ${url}/#sid=demo&ct=${consumerToken}&ht=${humanToken}\n`);
  console.log(`  Automated site: ${site.url}   |   human input coverage: ${trace.capabilities().humanInput.coverage}\n`);
  console.log("  Ctrl+C to stop.\n");

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    site.server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
