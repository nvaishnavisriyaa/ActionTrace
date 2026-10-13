#!/usr/bin/env node
/**
 * actiontrace-mcp: stdio MCP server for a running ActionTrace sidecar. Works with any MCP client.
 *
 * Simplest: point it at the connection file written by `actiontrace serve --info-file`:
 *
 *   ACTIONTRACE_INFO=/path/to/actiontrace-session.json actiontrace-mcp
 *
 * That enables the actiontrace_* tools (what changed) and the browser_* tools (attributed actions).
 *
 * Or configure by variable. Read-only (actiontrace_* tools only):
 *   ACTIONTRACE_URL, ACTIONTRACE_SESSION, ACTIONTRACE_TOKEN (consumer token)
 * Add the browser_* tools with:
 *   ACTIONTRACE_AGENT_TOKEN and ACTIONTRACE_CDP (the sidecar's DevTools endpoint)
 *
 * Configuration is by environment variable, not argv, so tokens do not show up in process lists.
 * stdout carries the MCP protocol; diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadSessionInfo, type SessionInfo } from "./actions.js";
import { TraceClient } from "./client.js";
import { createMcpServer } from "./mcp.js";

const env = process.env;
let info: SessionInfo | undefined;

try {
  if (env.ACTIONTRACE_INFO) {
    info = loadSessionInfo(env.ACTIONTRACE_INFO);
  } else if (env.ACTIONTRACE_URL && env.ACTIONTRACE_SESSION && env.ACTIONTRACE_TOKEN) {
    info = {
      url: env.ACTIONTRACE_URL,
      sessionId: env.ACTIONTRACE_SESSION,
      tokens: { consumer: env.ACTIONTRACE_TOKEN, agent: env.ACTIONTRACE_AGENT_TOKEN ?? "" },
      cdpEndpoint: env.ACTIONTRACE_AGENT_TOKEN ? env.ACTIONTRACE_CDP : undefined,
    };
  }
} catch (e) {
  console.error(`actiontrace-mcp: ${(e as Error).message}`);
  process.exit(2);
}

if (!info) {
  console.error("actiontrace-mcp: set ACTIONTRACE_INFO (path to the sidecar's --info-file), or ACTIONTRACE_URL, ACTIONTRACE_SESSION and ACTIONTRACE_TOKEN (the consumer token).");
  process.exit(2);
}

const server = createMcpServer(new TraceClient({ url: info.url, sessionId: info.sessionId, token: info.tokens.consumer }), { info });
await server.connect(new StdioServerTransport());
console.error(
  `actiontrace-mcp: session "${info.sessionId}" at ${info.url}; ${info.cdpEndpoint ? "browser_* action tools enabled" : "read-only (no DevTools endpoint / agent token)"}`,
);
