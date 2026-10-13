/**
 * `actiontrace agent <command>`: shell-callable browser actions with attribution built in.
 *
 * For any AI tool that can run shell commands (Claude Code, Cursor, Aider, a custom agent loop...).
 * Each action: resolve the element, register the command with the AI token, perform it in the
 * sidecar's browser over DevTools, end the command. `changes` reports what the user did meanwhile.
 *
 *   actiontrace agent snapshot
 *   actiontrace agent changes
 *   actiontrace agent click --label "Basic plan"
 *   actiontrace agent fill  --label "Full name" --text "Ada"
 *   actiontrace agent goto  http://localhost:3000/step2.html
 *
 * Connection details come from the file written by `actiontrace serve --info-file`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { performAction, loadSessionInfo, type ActionRequest } from "./actions.js";
import { formatChanges } from "./changes.js";
import { TraceClient } from "./client.js";

export const AGENT_HELP = `actiontrace agent <command> [options]

  snapshot                  List the interactive elements on the page (role + label).
  changes [--peek]          What the user and the page changed since your last call. Run this before acting.
  click  --label <l> [--role <r>]
  fill   --label <l> --text <t> [--role <r>]
  press  --label <l> --key <k> [--role <r>]
  goto   <url>
  status                    Coverage and stream health.

Options:
  --info <file>      Connection file written by "actiontrace serve --info-file" (default: $ACTIONTRACE_INFO or ./actiontrace-session.json)
  --tab <tabId>      Which tab to act in (default: the first tab).
  --agent-id <id>    Name recorded for this agent (default: cli-agent).
  --timeout <ms>     Per-action timeout (default 5000).
`;

export async function agentMain(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "help") {
    console.log(AGENT_HELP);
    return sub ? 0 : 2;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      info: { type: "string" },
      tab: { type: "string" },
      label: { type: "string" },
      role: { type: "string" },
      text: { type: "string" },
      key: { type: "string" },
      peek: { type: "boolean", default: false },
      "agent-id": { type: "string", default: "cli-agent" },
      timeout: { type: "string", default: "5000" },
    },
  });
  const infoPath = values.info ?? process.env.ACTIONTRACE_INFO ?? "actiontrace-session.json";
  const info = loadSessionInfo(infoPath);
  const common = { url: info.url, sessionId: info.sessionId };
  const reader = new TraceClient({ ...common, token: info.tokens.consumer });

  if (sub === "status") {
    console.log(JSON.stringify(await reader.capabilities(), null, 2));
    return 0;
  }

  if (sub === "changes") {
    // Stateless process, so the "since my last call" cursor lives next to the connection file.
    const cursorPath = `${infoPath}.cursor`;
    const caps = await reader.capabilities();
    let cursor: number | undefined;
    try {
      const c = JSON.parse(readFileSync(cursorPath, "utf8")) as { url: string; sessionId: string; cursor: number };
      if (c.url === info.url && c.sessionId === info.sessionId && c.cursor <= caps.stream.lastSequence) cursor = c.cursor;
    } catch {
      /* first call */
    }
    if (cursor === undefined) {
      writeFileSync(cursorPath, JSON.stringify({ ...common, cursor: caps.stream.lastSequence }));
      console.log("Baseline set. Future calls report what changed after this point.");
      return 0;
    }
    const update = await reader.context(cursor);
    if (!values.peek) writeFileSync(cursorPath, JSON.stringify({ ...common, cursor: update.toSequence }));
    console.log(formatChanges(update, caps));
    return 0;
  }

  let req: ActionRequest;
  switch (sub) {
    case "snapshot":
      req = { action: "snapshot" };
      break;
    case "goto":
      if (!positionals[0]) throw new Error("goto needs a URL");
      req = { action: "goto", url: positionals[0] };
      break;
    case "click":
    case "fill":
    case "press": {
      if (!values.label) throw new Error(`${sub} needs --label`);
      if (sub === "fill" && values.text === undefined) throw new Error("fill needs --text");
      if (sub === "press" && !values.key) throw new Error("press needs --key");
      req =
        sub === "click"
          ? { action: "click", label: values.label, role: values.role }
          : sub === "fill"
            ? { action: "fill", label: values.label, role: values.role, text: values.text! }
            : { action: "press", label: values.label, role: values.role, key: values.key! };
      break;
    }
    default:
      console.error(`unknown command "${sub}"\n\n${AGENT_HELP}`);
      return 2;
  }
  const r = await performAction(info, req, { agentId: values["agent-id"]!, tabId: values.tab, timeoutMs: Number(values.timeout) || 5000 });
  console.log(r.text);
  return r.performed ? 0 : 1;
}
