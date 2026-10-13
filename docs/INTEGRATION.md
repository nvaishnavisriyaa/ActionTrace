# Integrating ActionTrace with an AI tool

ActionTrace answers one question for the controller of an AI browsing tool: **who did this, and how sure are
we?** To do that it needs two things from you:

1. **The AI's actions, registered before they are dispatched.** That is what proves "the AI issued this".
2. **A way for the controller to read the result** and put "what changed since I last looked" into the
   model's next prompt.

Everything else (observing the page, the human channel, replay, redaction) is done by ActionTrace.

## Pick your path

| Your AI tool... | Use | Attribution of the AI's actions |
|---|---|---|
| is TypeScript/Node and drives Playwright itself | **In-process SDK**: `ActionTrace.attach` + `runAIAction` ([README](../README.md#integrating)) | Automatic, target-verified |
| is TypeScript/Node, but you can't or won't share a process | **Sidecar + `AgentClient` / `TraceClient`** | You bracket each action |
| is in another language (Python, Go, ...) | **Sidecar + HTTP API** ([reference](#http-api)); see `examples/python/controller.py` | You bracket each action |
| can run shell commands (Claude Code, Cursor, Aider, a shell-tool agent) | **Sidecar + `actiontrace agent ...`** ([demo](DEMO.md)) | Automatic, target-verified |
| **speaks MCP (Codex, Antigravity, Claude Code/Desktop, Cursor, ...)** | **`actiontrace-mcp`: the recommended path.** One config entry; the model uses its `browser_*` tools | Automatic, target-verified |
| is a closed product (ChatGPT, hosted agents, ...) | Only if it exposes a browser-controller hook you can run code in. None is assumed. | n/a |
| uses another automation framework (Puppeteer, Selenium, CDP) | Write a `BrowserAdapter` ([below](#writing-an-adapter)), or use the sidecar | Depends |

### Why attribution needs your help for external tools

If another program clicks in the browser, ActionTrace sees a trusted click that matches no registered
source. It does **not** guess: the event is `unknown`, and human-input coverage is reported as `limited`.
Registering the command first turns that into `ai` / `confirmed`. That is deliberate. An unregistered click
credited to "the AI" or "the human" would be a guess that looks like a fact.

## The sidecar

```bash
actiontrace serve --url https://example.com --port 4173 --cdp-port 9222 --info-file actiontrace-session.json
```

(From a source checkout: `node dist/src/cli.js serve ...`; to get the `actiontrace` and `actiontrace-mcp`
commands on your PATH, run `npm link` once.)

It starts your installed Chrome or Edge on a **fresh, temporary profile**, the engine, the event server and
the viewer, and prints (stdout, one JSON line, and the optional info file):

```json
{ "url": "http://127.0.0.1:4173", "sessionId": "main",
  "tokens": { "consumer": "...", "agent": "...", "human": "..." },
  "ui": "http://127.0.0.1:4173/#sid=main&ct=...&ht=...",
  "cdpEndpoint": "http://127.0.0.1:9222",
  "mcp": { "command": "actiontrace-mcp", "env": { ... } } }
```

| Token | Grants | Give it to |
|---|---|---|
| `consumer` | Read events, context, capabilities, tabs | The controller / MCP bridge |
| `agent` | Register AI commands | **Only the AI tool.** A command is a claim that "the AI did this" |
| `human` | Send input through the viewer | The viewer UI |

Set `ACTIONTRACE_CONSUMER_TOKEN`, `ACTIONTRACE_AGENT_TOKEN`, `ACTIONTRACE_HUMAN_TOKEN` (16+ characters) to
keep tokens stable across restarts. Flags: `--headed`, `--browser msedge`, `--no-ui`,
`--exit-on-stdin-close` (for a parent process that spawns it).

`--cdp-port` lets other tools drive the same browser (Playwright `connectOverCDP`, Puppeteer, Playwright
MCP `--cdp-endpoint`, browser-use...). The port is bound to 127.0.0.1, but **any local process can control
the browser through it.** Leave it off if you don't need it.

## Registering AI commands

The rule: **register before dispatch, end after.** Three ways, all equivalent on the wire.

```ts
// TypeScript, in-process (same process as the Playwright BrowserContext)
await trace.runAIAction({ agentId, action: "click", tabId, resolveTarget: () => pw.describe(locator) }, () => locator.click());

// TypeScript, another process
const agent = new AgentClient({ url, sessionId, token: info.tokens.agent });
await agent.run({ agentId, action: "click", tabId, target: { role: "button", label: "Save" } }, () => page.click("text=Save"));

// Shell
actiontrace agent click --label "Save"
```

Give the engine a `target` (`role` + `label`) when you can. A matching target makes the attribution
`confirmed`; no target makes it `inferred`; a target that contradicts the event makes it not attributed
(`unknown`). Get `tabId` from `GET /tabs` (omit it to match any tab).

Every command has a **lease** (default 60 s, max 300 s). If `end` is not called in time, for instance because
your process crashed, the command is closed as `failed` and any weak attribution it made is downgraded. At
most 64 commands can be open per session. Typed text is never recorded; only that an edit happened.

## Consuming: what the model should be told

Ask for "what changed since I last looked" at each model step, and inject it at the model's next supported
execution boundary:

```ts
const update = await reader.context(cursor);   // GET /context?since=
cursor = update.toSequence;
prompt += update.summary;                      // plus update.humanTouched for structured use
```

`summary` already puts warnings first (stale data, degraded coverage) and quotes page-derived labels as JSON
strings. **Page text is untrusted data**; keep it quoted, and do not let it act as instructions.

For live delivery, `reader.stream(onEvent, { since })` reconnects and resumes automatically; a `stream_gap`
record tells you exactly what was missed. ActionTrace never interrupts a running model or command. That is
a host capability you wire to the stream yourself.

## MCP (the tool-neutral path)

Any MCP client that can launch a stdio server can integrate: you give it a command and an environment.
Start the sidecar with `--cdp-port 9222 --info-file <path>` ([above](#the-sidecar)), then register:

```json
{ "mcpServers": { "actiontrace": { "command": "actiontrace-mcp",
  "env": { "ACTIONTRACE_INFO": "C:\\path\\to\\actiontrace-session.json" } } } }
```

Use whatever shape your client's config takes (JSON `mcpServers`, TOML, a UI form); only the command and the
environment matter. From a source checkout use `"command": "node"` with
`"args": ["C:\\Drive\\ActionTrace\\dist\\src\\cli-mcp.js"]`. For stable configs, fix the sidecar's tokens with
the `ACTIONTRACE_*_TOKEN` variables, or point `ACTIONTRACE_INFO` at a file you regenerate.

**Tools**

| Tool | Does |
|---|---|
| `actiontrace_changes` | What the user and the page changed since the model's previous call. `peek` doesn't advance the cursor |
| `actiontrace_events`, `actiontrace_capabilities` | Raw attributed events; coverage and stream health |
| `browser_snapshot` | Lists interactive elements (role + label) |
| `browser_navigate`, `browser_click`, `browser_fill`, `browser_press` | Act in the shared browser, **recorded as AI actions** |

What the action tools do for you, so the host needs no code:

* Each action is registered as an AI command **before** it is dispatched, with the element described the same
  way the observer describes it, so the attribution is `confirmed`.
* The attributed agent id is the MCP client's own name (from the protocol handshake), so the timeline shows
  which tool acted.
* Every result starts with what the user changed since the model last called `actiontrace_changes`. The
  action tools never advance that cursor, so nothing is consumed without being shown.
* If the action targets an element the user touched since then, **nothing is done** until the model calls
  `actiontrace_changes`. After that it may proceed, including overwriting the user's change: it is a
  guarantee that the model has been told, not a lock, and it does not judge whether overwriting is wise.
  That judgement stays with the model and its instructions.
* `browser_snapshot` marks `[checked]` and `[filled]` (never values), so the model can see state without
  seeing what the user typed.
* `browser_navigate` accepts http(s) only; typed text is never recorded.

Without `ACTIONTRACE_INFO`, you can set `ACTIONTRACE_URL`, `ACTIONTRACE_SESSION` and `ACTIONTRACE_TOKEN` (the
consumer token). That gives the three read-only `actiontrace_*` tools. Add `ACTIONTRACE_AGENT_TOKEN` and
`ACTIONTRACE_CDP` for the `browser_*` tools. Configuration is by environment, so tokens stay out of process
lists.

**Important limit.** The model must use ActionTrace's `browser_*` tools for its actions to be attributed. A host
that also ships its own built-in browser tool (many do) acts through *that* browser, which ActionTrace cannot
see. Tell the model, in the host's instructions, to use `browser_*` for the shared browser. If something
else drives the sidecar's browser without registering, its actions are `unknown`, never guessed.

A proxy that wraps another browser MCP server (e.g. Playwright MCP) and registers its tool calls is not built.

## HTTP API

Base `http://127.0.0.1:<port>`; `Authorization: Bearer <token>`; JSON. The event schema is
[`schema/trace-event.schema.json`](../schema/trace-event.schema.json). Only loopback `Host` and same-origin
`Origin` values are accepted.

| Method and path | Token | Body / query | Returns |
|---|---|---|---|
| `GET /api/sessions/:id/events` | consumer | `since`, `limit` (≤1000) | `{events, gap?, lastSequence}` |
| `GET /api/sessions/:id/context` | consumer | `since` | what-changed update (`summary`, `humanTouched`, ...) |
| `GET /api/sessions/:id/capabilities` | consumer | | coverage and stream health |
| `GET /api/sessions/:id/tabs` | consumer | | `{tabs:[{tabId,url}]}` |
| `POST /api/sessions/:id/observation` | consumer | `{enabled}` | capabilities |
| `POST /api/sessions/:id/commands` | agent | `{agentId, action, tabId?, target?:{role,label}, url?, claims?, leaseMs?}` | `201 {actionId}` |
| `POST /api/sessions/:id/commands/:actionId/end` | agent | `{status: completed\|failed\|cancelled, error?}` | `{actionId, status}` |
| `WS /ws/stream` | consumer | first message `{type:"auth", sessionId, token, since?}` | `hello`, then `{type:"event", event}` |

Errors: `401` bad token, `400` invalid body (message says which field), `404` unknown command, `429` too many
open commands. Never put a token in a URL.

```bash
curl -s -X POST -H "Authorization: Bearer $AGENT" -H "Content-Type: application/json" \
  -d '{"agentId":"my-agent","action":"click","target":{"role":"button","label":"Save"}}' \
  http://127.0.0.1:4173/api/sessions/main/commands
```

## Writing an adapter

To observe a browser that isn't driven through Playwright, implement `BrowserAdapter` from
`src/protocol.ts`:

```ts
interface BrowserAdapter {
  name: string;
  capabilities(): Capabilities["observer"];
  start(sink: ObservationSink): Promise<void>;   // call sink.observe({...}) for everything you see
  stop(): Promise<void>;
}
```

Rules that keep attribution honest:

* **Report what happened, never who did it.** An observation has no actor field and the engine ignores any
  you add.
* Set `trusted` from the browser's `Event.isTrusted`. Script-dispatched events are labelled `page`.
* Give every message a unique `msgId`, a stable `tabId`, and the browser's event time in `at`.
* Never read input values, keys or value lengths.
* Inject the observer with `buildObserverSource({ binding })` (exported) through your framework's
  "run on every new document" mechanism, and forward what it sends to the binding as `BrowserObservation`s.
  `src/adapters/playwright.ts` is the reference.
* For a human input channel, implement `HumanInputAdapter` and call `recordIntent()` **before** the input
  reaches the browser. `src/adapters/viewer.ts` is the reference.

## What is and isn't verified

| Path | Status |
|---|---|
| In-process Playwright SDK | Tested in real Chrome (`test/e2e.test.ts`, `bench/run.ts`) |
| Commands API, leases, auth, clients | Tested (`test/integration.test.ts`) |
| MCP server: `actiontrace_*` and `browser_*` tools, conflict guard, client name as agent id | Tested over stdio with the MCP SDK's client (`test/integration.test.ts`, `test/sidecar.test.ts`). Loaded and exercised once in a real Claude app session, which found and led to a fix of a bug where action tools swallowed events |
| Real hosts as the MCP client (Codex, Antigravity, Claude Code/Desktop, Cursor) | **Not tested.** The protocol path is tested; none of those apps has been run against it |
| Sidecar driven by a second Playwright process over CDP; `actiontrace agent` | Tested in real Chrome (`test/sidecar.test.ts`) |
| Python example | Run once against a live sidecar; not in the test suite |
| Playwright MCP, Puppeteer, Selenium, browser-use, Claude Code / Cursor as drivers | **Not tested.** They should work through the sidecar, but nobody has run them |
| Closed AI products | Not assumed; depends on their exposing a controller hook |

Security notes for integrators: bind to loopback only (the default); treat `agent` and `human` tokens as
credentials; the info file contains tokens; a hostile page can forge observations (it cannot assign an actor),
see the README threat model.
