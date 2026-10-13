/**
 * Clients for a running TraceServer, for tools that live in another process.
 *
 *   TraceClient  - read side: events, "what changed", capabilities, live stream with resume.
 *   AgentClient  - write side: register AI commands before dispatch, end them after.
 *
 * Only `fetch` and the global `WebSocket` are used, so these also work in Deno, Bun and browsers.
 * The wire format is documented in docs/INTEGRATION.md, for tools that talk HTTP directly instead.
 */
import type { ContextUpdate } from "./context.js";
import type { AICommandMeta, Capabilities, ObservationType, Target, TraceEvent } from "./protocol.js";

export class ActionTraceHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ActionTraceHttpError";
  }
}

export interface ClientOptions {
  /** Base URL of the TraceServer, e.g. http://127.0.0.1:4173 */
  url: string;
  sessionId: string;
  /** Consumer token for TraceClient, agent token for AgentClient. Sent as a Bearer header, never in a URL. */
  token: string;
  fetch?: typeof fetch;
}

async function call<T>(o: ClientOptions, method: string, path: string, body?: unknown): Promise<T> {
  const f = o.fetch ?? fetch;
  const res = await f(new URL(`/api/sessions/${encodeURIComponent(o.sessionId)}${path}`, o.url), {
    method,
    headers: { Authorization: `Bearer ${o.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) throw new ActionTraceHttpError(res.status, (json as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`);
  return json as T;
}

export interface StreamOptions {
  /** Resume after this sequence number. Omit to receive live events only. */
  since?: number;
  /** Reconnect automatically (with the last seen sequence) when the connection drops. Default true. */
  reconnect?: boolean;
  onHello?: (hello: { sessionId: string; lastSequence: number; capabilities: Capabilities }) => void;
  onClose?: (info: { code: number; reason: string; willReconnect: boolean }) => void;
}

export class TraceClient {
  constructor(private readonly o: ClientOptions) {}

  events(since = 0, limit?: number) {
    const q = new URLSearchParams({ since: String(since), ...(limit ? { limit: String(limit) } : {}) });
    return call<{ events: TraceEvent[]; gap?: { fromSequence: number; toSequence: number; lost: number }; lastSequence: number }>(this.o, "GET", `/events?${q}`);
  }

  /** The concise "what changed since sequence N" update. Does not move any cursor on the server. */
  context(since = 0) {
    return call<ContextUpdate>(this.o, "GET", `/context?since=${since}`);
  }

  capabilities() {
    return call<Capabilities>(this.o, "GET", "/capabilities");
  }

  tabs() {
    return call<{ tabs: { tabId: string; url: string }[] }>(this.o, "GET", "/tabs").then((r) => r.tabs);
  }

  setObservation(enabled: boolean) {
    return call<Capabilities>(this.o, "POST", "/observation", { enabled });
  }

  /**
   * Live stream with automatic resume. `stream_gap` records are delivered through `onEvent` like any
   * other event, so the consumer sees exactly what it missed. Returns a function that stops it.
   */
  stream(onEvent: (e: TraceEvent) => void, opts: StreamOptions = {}): () => void {
    let stopped = false;
    let last = opts.since;
    let attempt = 0;
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wsUrl = new URL("/ws/stream", this.o.url);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => ws!.send(JSON.stringify({ type: "auth", sessionId: this.o.sessionId, token: this.o.token, since: last }));
      ws.onmessage = (m) => {
        let msg: { type?: string; event?: TraceEvent } & Record<string, unknown>;
        try {
          msg = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (msg.type === "hello") {
          attempt = 0;
          opts.onHello?.(msg as never);
        } else if (msg.type === "event" && msg.event) {
          last = Math.max(last ?? 0, msg.event.sequence);
          onEvent(msg.event);
        }
      };
      ws.onclose = (ev) => {
        const again = !stopped && opts.reconnect !== false && ev.code !== 4403;
        opts.onClose?.({ code: ev.code, reason: ev.reason, willReconnect: again });
        if (again) timer = setTimeout(connect, Math.min(5000, 250 * 2 ** attempt++));
      };
      ws.onerror = () => undefined; // onclose follows
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }
}

export interface AgentCommand extends Pick<AICommandMeta, "agentId" | "action" | "tabId" | "url" | "target"> {
  claims?: ObservationType[];
  /** If `end` is not called within this time the server closes the command as failed. Default 60000. */
  leaseMs?: number;
}

export class AgentClient {
  constructor(private readonly o: ClientOptions) {}

  /** Register a command *before* dispatching the browser action. Returns its actionId. */
  async begin(cmd: AgentCommand): Promise<string> {
    return (await call<{ actionId: string }>(this.o, "POST", "/commands", cmd)).actionId;
  }

  async end(actionId: string, status: "completed" | "failed" | "cancelled", error?: string): Promise<void> {
    await call(this.o, "POST", `/commands/${encodeURIComponent(actionId)}/end`, { status, error });
  }

  /** begin, run, end: the remote equivalent of ActionTrace.runAIAction. */
  async run<T>(cmd: AgentCommand, fn: () => Promise<T> | T, opts: { signal?: AbortSignal } = {}): Promise<T> {
    const id = await this.begin(cmd);
    try {
      const r = await fn();
      await this.end(id, "completed");
      return r;
    } catch (err) {
      const cancelled = opts.signal?.aborted || (err as { name?: string } | null)?.name === "AbortError";
      await this.end(id, cancelled ? "cancelled" : "failed", err instanceof Error ? err.message : String(err)).catch(() => undefined);
      throw err;
    }
  }
}

export type { Target };
