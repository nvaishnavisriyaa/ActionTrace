import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { ActionTrace, AICommandHandle } from "./actiontrace.js";
import type { ViewerAdapter } from "./adapters/viewer.js";
import { SCHEMA_VERSION, type AICommandMeta, type ObservationType, type TraceEvent } from "./protocol.js";

export interface SessionRegistration {
  trace: ActionTrace;
  /** Grants read access to the stream, replay, context and capabilities of this session only. */
  consumerToken: string;
  /** Grants the right to send human input through the viewer channel. */
  humanToken?: string;
  /**
   * Grants the right to register AI commands over HTTP (`POST .../commands`). Distinct from the
   * consumer token on purpose: registering a command is a claim that "the AI did this", so only the
   * AI tool itself should hold it. Without it, the command routes are disabled for this session.
   */
  agentToken?: string;
  viewer?: ViewerAdapter;
  /** Lists the tabs of the observed browser so remote tools can address one. Optional. */
  tabs?: () => { tabId: string; url: string }[];
}

const MAX_OPEN_REMOTE_COMMANDS = 64;
const OBSERVATION_TYPES = new Set<ObservationType>(["click", "edit", "scroll", "mutation", "navigation", "tab_opened", "tab_closed"]);
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

/** Validates an untrusted command registration. Returns an error string or the parsed command. */
export function parseCommandRequest(body: unknown): { error: string } | { meta: AICommandMeta; leaseMs?: number } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "JSON object body required" };
  const b = body as Record<string, unknown>;
  const agentId = str(b.agentId, 64);
  const action = str(b.action, 32);
  if (!agentId) return { error: "agentId (1-64 chars) required" };
  if (!action || !/^[a-z][a-z0-9_]*$/i.test(action)) return { error: "action (letters, digits, underscore; max 32) required" };
  const meta: AICommandMeta = { agentId, action };
  if (b.tabId !== undefined) {
    meta.tabId = str(b.tabId, 32);
    if (!meta.tabId) return { error: "tabId must be a string of at most 32 chars" };
  }
  if (b.url !== undefined) {
    meta.url = str(b.url, 2000);
    if (!meta.url) return { error: "url must be a string of at most 2000 chars" };
  }
  if (b.target !== undefined) {
    if (!b.target || typeof b.target !== "object" || Array.isArray(b.target)) return { error: "target must be an object" };
    const t = b.target as Record<string, unknown>;
    meta.target = { role: str(t.role, 32), label: str(t.label, 120), tag: str(t.tag, 24), inputType: str(t.inputType, 24) };
    if (t.sensitive === true) meta.target.sensitive = true;
    for (const k of Object.keys(meta.target) as (keyof typeof meta.target)[]) if (meta.target[k] === undefined) delete meta.target[k];
  }
  if (b.claims !== undefined) {
    if (!Array.isArray(b.claims) || b.claims.length > 8 || !b.claims.every((c) => OBSERVATION_TYPES.has(c as ObservationType))) {
      return { error: `claims must be an array of: ${[...OBSERVATION_TYPES].join(", ")}` };
    }
    meta.claims = b.claims as ObservationType[];
  }
  let leaseMs: number | undefined;
  if (b.leaseMs !== undefined) {
    if (typeof b.leaseMs !== "number" || !Number.isFinite(b.leaseMs)) return { error: "leaseMs must be a number" };
    leaseMs = b.leaseMs;
  }
  return { meta, leaseMs };
}

export interface TraceServerOptions {
  host?: string;
  port?: number;
  /** Directory of static files (timeline / viewer UI). */
  staticDir?: string;
  /** Extra hostnames accepted in Host / Origin checks, beyond loopback. */
  allowedHosts?: string[];
  /** Hook for host-specific routes. Return true if handled. */
  onRequest?: (req: IncomingMessage, res: ServerResponse, server: TraceServer) => boolean | Promise<boolean>;
  /** Close a consumer that has more than this many bytes queued. It can reconnect and resume with `since`. */
  maxBufferedBytes?: number;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export const newToken = () => randomBytes(24).toString("base64url");

const digest = (s: string) => createHash("sha256").update(s).digest();
function tokenOk(given: unknown, expected: string | undefined): boolean {
  if (typeof given !== "string" || !expected) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

export function gapRecord(sessionId: string, g: { fromSequence: number; toSequence: number; lost: number }): TraceEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    eventId: `gap-${g.fromSequence}-${g.toSequence}`,
    sequence: g.toSequence,
    observedAt: new Date().toISOString(),
    kind: "stream_gap",
    action: "gap",
    actor: "unknown",
    certainty: "unknown",
    evidence: [],
    relatedActionIds: [],
    details: { fromSequence: g.fromSequence, toSequence: g.toSequence, lost: g.lost },
  };
}

export class TraceServer {
  private http?: Server;
  private readonly sessions = new Map<string, SessionRegistration>();
  private readonly everConnected = new Set<string>();
  private readonly streamWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private readonly viewerWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private readonly opts: Required<Pick<TraceServerOptions, "host" | "port" | "maxBufferedBytes">> & TraceServerOptions;
  private heartbeat?: NodeJS.Timeout;

  constructor(opts: TraceServerOptions = {}) {
    this.opts = { host: "127.0.0.1", port: 0, maxBufferedBytes: 4 * 1024 * 1024, ...opts };
  }

  addSession(reg: SessionRegistration): void {
    this.sessions.set(reg.trace.sessionId, reg);
  }

  /** Returns the session only if the Bearer token matches that session's consumer token. */
  authenticate(req: IncomingMessage, sessionId: string): SessionRegistration | undefined {
    const reg = this.sessions.get(sessionId);
    return reg && tokenOk(bearer(req), reg.consumerToken) ? reg : undefined;
  }

  /** Same, for the agent token that may register AI commands. */
  authenticateAgent(req: IncomingMessage, sessionId: string): SessionRegistration | undefined {
    const reg = this.sessions.get(sessionId);
    return reg && tokenOk(bearer(req), reg.agentToken) ? reg : undefined;
  }

  private readonly remoteCommands = new Map<string, Map<string, AICommandHandle>>();

  private async handleCommands(sessionId: string, endId: string | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reg = this.authenticateAgent(req, sessionId);
    if (!reg) return send(res, 401, { error: "unauthorized" });
    if (req.method !== "POST") return send(res, 405, { error: "POST required" });
    let open = this.remoteCommands.get(sessionId);
    if (!open) this.remoteCommands.set(sessionId, (open = new Map()));
    const body = await readJson(req);

    if (endId === undefined) {
      const parsed = parseCommandRequest(body);
      if ("error" in parsed) return send(res, 400, { error: parsed.error });
      for (const [id, h] of open) if (!h.open) open.delete(id);
      if (open.size >= MAX_OPEN_REMOTE_COMMANDS) return send(res, 429, { error: "too many open commands; end some first" });
      const handle = reg.trace.beginAICommand(parsed.meta, { leaseMs: parsed.leaseMs });
      open.set(handle.actionId, handle);
      return send(res, 201, { actionId: handle.actionId, leaseMs: Math.min(Math.max(parsed.leaseMs ?? 60_000, 100), 300_000) });
    }

    const handle = open.get(endId);
    if (!handle) return send(res, 404, { error: "unknown command (only commands registered over this API can be ended here)" });
    const b = (body ?? {}) as { status?: unknown; error?: unknown };
    if (b.status !== "completed" && b.status !== "failed" && b.status !== "cancelled") {
      return send(res, 400, { error: "status must be completed, failed or cancelled" });
    }
    const wasOpen = handle.open;
    handle.end(b.status, typeof b.error === "string" ? b.error.slice(0, 200) : undefined);
    open.delete(endId);
    return send(res, 200, { actionId: endId, status: b.status, alreadyEnded: !wasOpen });
  }

  async listen(): Promise<{ url: string; port: number }> {
    this.http = createServer((req, res) => void this.handleHttp(req, res));
    this.http.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      const wss = path === "/ws/stream" ? this.streamWss : path === "/ws/viewer" ? this.viewerWss : undefined;
      if (!wss || !this.hostAndOriginOk(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => (wss === this.streamWss ? this.onStream(ws) : this.onViewer(ws)));
    });
    this.heartbeat = setInterval(() => {
      for (const wss of [this.streamWss, this.viewerWss]) {
        for (const ws of wss.clients as Set<WebSocket & { alive?: boolean }>) {
          if (ws.alive === false) ws.terminate();
          else {
            ws.alive = false;
            ws.ping();
          }
        }
      }
    }, 15000);
    this.heartbeat.unref();
    await new Promise<void>((ok) => this.http!.listen(this.opts.port, this.opts.host, ok));
    const port = (this.http.address() as AddressInfo).port;
    return { url: `http://${this.opts.host}:${port}`, port };
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const wss of [this.streamWss, this.viewerWss]) for (const c of wss.clients) c.terminate();
    await new Promise<void>((ok) => (this.http ? this.http.close(() => ok()) : ok()));
  }

  // ------------------------------------------------------------------ security

  private hostnameOk(h: string | undefined): boolean {
    if (!h) return false;
    const name = h.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    return ["127.0.0.1", "localhost", "::1", ...(this.opts.allowedHosts ?? [])].includes(name);
  }

  /** Blocks DNS-rebinding (Host) and cross-site WebSocket hijacking (Origin). */
  private hostAndOriginOk(req: IncomingMessage): boolean {
    if (!this.hostnameOk(req.headers.host)) return false;
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        if (o.host !== req.headers.host) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ HTTP

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.hostnameOk(req.headers.host)) return send(res, 403, { error: "forbidden host" });
      const url = new URL(req.url ?? "/", "http://x");
      if (this.opts.onRequest && (await this.opts.onRequest(req, res, this))) return;

      const c = /^\/api\/sessions\/([^/]+)\/commands(?:\/([^/]+)\/end)?$/.exec(url.pathname);
      if (c) return await this.handleCommands(decodeURIComponent(c[1]), c[2] === undefined ? undefined : decodeURIComponent(c[2]), req, res);

      const m = /^\/api\/sessions\/([^/]+)\/(events|context|capabilities|observation|tabs)$/.exec(url.pathname);
      if (m) {
        const reg = this.authenticate(req, decodeURIComponent(m[1]));
        if (!reg) return send(res, 401, { error: "unauthorized" });
        return await this.handleApi(reg, m[2], url, req, res);
      }
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
      return this.serveStatic(url.pathname, res);
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
      void err;
    }
  }

  private async handleApi(reg: SessionRegistration, what: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const since = Math.max(0, Number(url.searchParams.get("since") ?? 0) || 0);
    switch (what) {
      case "events": {
        const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 500) || 500);
        const { events, gap } = reg.trace.eventsSince(since, limit);
        return send(res, 200, { events, gap, lastSequence: reg.trace.log.lastSequence });
      }
      case "context":
        return send(res, 200, reg.trace.contextSince(since));
      case "capabilities":
        return send(res, 200, reg.trace.capabilities());
      case "tabs":
        return send(res, 200, { tabs: reg.tabs?.() ?? [] });
      case "observation": {
        if (req.method !== "POST") return send(res, 405, { error: "POST required" });
        const body = (await readJson(req)) as { enabled?: unknown } | undefined;
        if (typeof body?.enabled !== "boolean") return send(res, 400, { error: "enabled (boolean) required" });
        reg.trace.setObservation(body.enabled);
        return send(res, 200, reg.trace.capabilities());
      }
    }
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    const root = this.opts.staticDir && resolve(this.opts.staticDir);
    if (!root) return send(res, 404, { error: "not found" });
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const file = normalize(join(root, rel));
    if (!(file === root || file.startsWith(root + sep)) || !existsSync(file) || !statSync(file).isFile()) {
      return send(res, 404, { error: "not found" });
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'",
    });
    createReadStream(file).pipe(res);
  }

  // ------------------------------------------------------------------ WebSocket: event stream

  private onStream(ws: WebSocket & { alive?: boolean }): void {
    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));
    const authTimer = setTimeout(() => ws.close(4401, "auth timeout"), 3000);
    let unsubscribe: (() => void) | undefined;
    let reg: SessionRegistration | undefined;

    ws.on("close", () => {
      clearTimeout(authTimer);
      unsubscribe?.();
      if (reg && reg.trace.log.listenerCount === 0 && this.everConnected.has(reg.trace.sessionId)) {
        reg.trace.setStreamHealth("disconnected", "no stream consumer is connected");
      }
    });

    ws.on("message", (data) => {
      const msg = parse(data);
      if (!msg) return;
      if (!reg) {
        // First message must authenticate. Tokens are never put in the URL.
        const candidate = typeof msg.sessionId === "string" ? this.sessions.get(msg.sessionId) : undefined;
        if (msg.type !== "auth" || !candidate || !tokenOk(msg.token, candidate.consumerToken)) {
          ws.close(4403, "unauthorized");
          return;
        }
        clearTimeout(authTimer);
        reg = candidate;
        const trace = reg.trace;
        this.everConnected.add(trace.sessionId);
        trace.setStreamHealth("healthy", "stream consumer connected");
        const since = typeof msg.since === "number" && msg.since >= 0 ? Math.floor(msg.since) : undefined;
        ws.send(
          JSON.stringify({
            type: "hello",
            schemaVersion: SCHEMA_VERSION,
            sessionId: trace.sessionId,
            lastSequence: trace.log.lastSequence,
            capabilities: trace.capabilities(),
          }),
        );
        const push = (event: TraceEvent) => {
          if (ws.readyState !== ws.OPEN) return;
          if (ws.bufferedAmount > this.opts.maxBufferedBytes) {
            ws.close(1013, "slow consumer: reconnect with since=<last sequence>");
            return;
          }
          ws.send(JSON.stringify({ type: "event", event }));
        };
        unsubscribe = trace.subscribe(push, {
          fromSequence: since,
          onGap: (g) => push(gapRecord(trace.sessionId, g)),
        });
        return;
      }
      if (msg.type === "context") {
        const since = typeof msg.since === "number" ? msg.since : 0;
        ws.send(JSON.stringify({ type: "context", update: reg.trace.contextSince(since) }));
      }
    });
  }

  // ------------------------------------------------------------------ WebSocket: human viewer channel

  private onViewer(ws: WebSocket & { alive?: boolean }): void {
    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));
    const authTimer = setTimeout(() => ws.close(4401, "auth timeout"), 3000);
    const unsubs: (() => void)[] = [];
    let viewer: ViewerAdapter | undefined;

    ws.on("close", () => {
      clearTimeout(authTimer);
      unsubs.forEach((u) => u());
    });

    const sendTabs = async () => {
      if (viewer && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "tabs", tabs: await viewer.tabs() }));
    };

    ws.on("message", (data) => {
      const msg = parse(data);
      if (!msg) return;
      if (!viewer) {
        const reg = typeof msg.sessionId === "string" ? this.sessions.get(msg.sessionId) : undefined;
        if (msg.type !== "auth" || !reg?.viewer || !tokenOk(msg.token, reg.humanToken)) {
          ws.close(4403, "unauthorized");
          return;
        }
        clearTimeout(authTimer);
        viewer = reg.viewer;
        unsubs.push(
          viewer.onFrame((f) => {
            if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1024 * 1024) ws.send(JSON.stringify({ type: "frame", ...f }));
          }),
          viewer.onTabsChanged(() => void sendTabs()),
        );
        ws.send(JSON.stringify({ type: "hello", channelId: viewer.channelId, sessionId: reg.trace.sessionId }));
        void sendTabs();
        return;
      }
      void viewer.handle(msg).then(() => (msg.type === "switch_tab" ? sendTabs() : undefined));
    });
  }
}

function bearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
}

function parse(data: unknown): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(String(data));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(json);
}

export function readJson(req: IncomingMessage, max = 64 * 1024): Promise<unknown> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        fail(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch {
        ok(undefined);
      }
    });
    req.on("error", fail);
  });
}
