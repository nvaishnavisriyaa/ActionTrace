import { AttributionEngine, type EngineOptions } from "./attribution.js";
import { ContextFeed, type ContextUpdate } from "./context.js";
import { EventLog, type Listener, type ReplayResult } from "./event-log.js";
import type {
  AICommandMeta,
  BrowserAdapter,
  BrowserObservation,
  Capabilities,
  Coverage,
  HumanInputAdapter,
  HumanIntent,
  HumanIntentSink,
  ObservationSink,
  StreamHealth,
  Unsubscribe,
} from "./protocol.js";

export interface AttachOptions {
  browserAdapter: BrowserAdapter;
  /** Zero or more instrumented human input channels. Without one, human input cannot be confirmed. */
  humanInputAdapter?: HumanInputAdapter | HumanInputAdapter[];
  sessionId?: string;
  /** Maximum retained events for replay. Older events are evicted and reported as a gap. */
  bufferSize?: number;
  engine?: EngineOptions;
}

export type RunAIActionMeta = AICommandMeta & { signal?: AbortSignal };

export interface AICommandHandle {
  readonly actionId: string;
  readonly open: boolean;
  /** Idempotent: only the first call has an effect. */
  end(status: "completed" | "failed" | "cancelled", error?: unknown): void;
}

const rank: Record<Coverage, number> = { none: 0, limited: 1, full: 2 };

/**
 * The SDK entry point. Wires adapters to the attribution engine and the event log.
 *
 *   const trace = await ActionTrace.attach({ browserAdapter, humanInputAdapter });
 *   trace.subscribe(e => agentContext.enqueue(e));
 *   await trace.runAIAction({ agentId, action: "click" }, () => page.click(...));
 */
export class ActionTrace implements ObservationSink, HumanIntentSink {
  readonly sessionId: string;
  readonly log: EventLog;
  private readonly engine: AttributionEngine;
  private readonly browser: BrowserAdapter;
  private readonly humans: HumanInputAdapter[];
  private humanDegraded?: string;
  private aiCoverage: { coverage: Coverage; notes: string[] } = { coverage: "full", notes: [] };
  private health: StreamHealth = "healthy";
  private lastCapKey = "";
  private started = false;

  private constructor(opts: AttachOptions) {
    this.sessionId = opts.sessionId ?? `session-${Math.random().toString(36).slice(2, 10)}`;
    this.log = new EventLog(this.sessionId, opts.bufferSize ?? 5000);
    this.browser = opts.browserAdapter;
    this.humans = opts.humanInputAdapter ? ([] as HumanInputAdapter[]).concat(opts.humanInputAdapter) : [];
    this.engine = new AttributionEngine(
      this.log,
      {
        humanCoverage: () => this.humanCoverage().coverage,
        onUninstrumentedInput: () => {
          if (this.humanDegraded) return;
          this.humanDegraded = "Input was observed that did not come through any instrumented human channel or registered AI command.";
          this.refreshCapabilities("uninstrumented input detected");
        },
      },
      opts.engine,
    );
  }

  static async attach(opts: AttachOptions): Promise<ActionTrace> {
    const t = new ActionTrace(opts);
    await t.start();
    return t;
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const h of this.humans) await h.start(this);
    await this.browser.start(this);
    this.lastCapKey = this.capKey();
  }

  async detach(): Promise<void> {
    await this.browser.stop();
    for (const h of this.humans) await h.stop();
    this.health = "disconnected";
    this.refreshCapabilities("trace detached");
  }

  // ------------------------------------------------------------------ inputs

  observe(obs: BrowserObservation): void {
    this.engine.ingest(obs);
  }

  recordIntent(intent: HumanIntent): void {
    this.engine.registerHumanIntent(intent);
  }

  /**
   * Run an AI browser command. The command is recorded *before* dispatch; its lifecycle
   * (started / completed / failed / cancelled) is streamed. Recording proves the AI issued the
   * command; it does not by itself claim every concurrent browser event.
   */
  async runAIAction<T>(meta: RunAIActionMeta, fn: () => Promise<T> | T): Promise<T> {
    const { signal, ...m } = meta;
    const id = this.engine.beginCommand(m);
    try {
      if (m.resolveTarget) {
        try {
          this.engine.setCommandTarget(id, await m.resolveTarget());
        } catch {
          /* unresolved target: the command still runs and will fail on its own if the element is missing */
        }
      }
      const r = await fn();
      this.engine.endCommand(id, "completed");
      return r;
    } catch (err) {
      const cancelled = signal?.aborted || (err as { name?: string } | null)?.name === "AbortError";
      this.engine.endCommand(id, cancelled ? "cancelled" : "failed", err);
      throw err;
    }
  }

  /**
   * Manual lifecycle for callers that cannot wrap the action in a callback (another process, another
   * language, an event-driven tool loop). Call before dispatching the browser action, and `end` after.
   *
   * An open command can explain browser events, so one that is never ended would keep claiming them.
   * Every command therefore has a lease: if `end` is not called within `leaseMs` it is closed as
   * failed, which also downgrades any weak attribution it made.
   */
  beginAICommand(meta: AICommandMeta, opts: { leaseMs?: number } = {}): AICommandHandle {
    const { resolveTarget: _ignored, ...m } = meta;
    void _ignored;
    const actionId = this.engine.beginCommand(m);
    let open = true;
    const finish = (status: "completed" | "failed" | "cancelled", error?: unknown) => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      this.engine.endCommand(actionId, status, error);
    };
    const leaseMs = Math.min(Math.max(opts.leaseMs ?? 60_000, 100), 300_000);
    const timer = setTimeout(() => finish("failed", new Error("command lease expired: end() was not called")), leaseMs);
    timer.unref();
    return {
      actionId,
      get open() {
        return open;
      },
      end: finish,
    };
  }

  /** Number of AI commands (from `runAIAction` or `beginAICommand`) that have not ended. */
  get openCommandCount(): number {
    return this.engine.openCommandCount;
  }

  // ------------------------------------------------------------------ consuming

  subscribe(listener: Listener, opts: { fromSequence?: number; onGap?: (g: NonNullable<ReplayResult["gap"]>) => void } = {}): Unsubscribe {
    return this.log.subscribe(listener, opts);
  }

  eventsSince(after = 0, limit?: number): ReplayResult {
    return this.log.since(after, limit);
  }

  /** A cursor that returns "what changed since my last observation". */
  contextFeed(startAfter = this.log.lastSequence): ContextFeed {
    return new ContextFeed(this.log, startAfter);
  }

  contextSince(after: number): ContextUpdate {
    return new ContextFeed(this.log, after).peek();
  }

  // ------------------------------------------------------------------ control & capabilities

  setObservation(on: boolean): void {
    this.engine.setObserving(on);
    this.refreshCapabilities(on ? "observation started" : "observation stopped");
  }

  /** Declare that some AI actions bypass `runAIAction` (so unmatched events cannot be assumed to be human). */
  declareAICoverage(coverage: Coverage, ...notes: string[]): void {
    this.aiCoverage = { coverage, notes };
    this.refreshCapabilities("AI command coverage declared");
  }

  setStreamHealth(h: StreamHealth, reason = "stream health changed"): void {
    if (h === this.health) return;
    this.health = h;
    this.refreshCapabilities(reason);
  }

  private humanCoverage(): { coverage: Coverage; notes: string[] } {
    if (!this.humans.length) return { coverage: "none", notes: ["No human input channel is attached: human input cannot be confirmed."] };
    let c: Coverage = "full";
    const notes: string[] = [];
    for (const h of this.humans) {
      if (rank[h.coverage()] < rank[c]) c = h.coverage();
      notes.push(...(h.notes?.() ?? []));
    }
    if (this.humanDegraded) {
      c = rank[c] > rank.limited ? "limited" : c;
      notes.push(this.humanDegraded);
    }
    return { coverage: c, notes };
  }

  capabilities(): Capabilities {
    const hc = this.humanCoverage();
    return {
      humanInput: { coverage: hc.coverage, channels: this.humans.map((h) => h.channelId), notes: hc.notes },
      aiCommands: { coverage: this.aiCoverage.coverage, notes: this.aiCoverage.notes },
      observer: { ...this.browser.capabilities(), observing: this.engine.isObserving },
      stream: {
        health: this.health,
        consumers: this.log.listenerCount,
        oldestSequence: this.log.oldestSequence,
        lastSequence: this.log.lastSequence,
        retained: this.log.retained,
        dropped: this.log.droppedCount,
        latencyMs: this.engine.latencyStats(),
      },
    };
  }

  private capKey(): string {
    const c = this.capabilities();
    return JSON.stringify([c.humanInput.coverage, c.aiCommands.coverage, c.observer.observing, c.stream.health]);
  }

  private refreshCapabilities(reason: string): void {
    if (!this.started) return;
    const key = this.capKey();
    if (key === this.lastCapKey) return;
    const prev = JSON.parse(this.lastCapKey || "[]") as [Coverage, Coverage, boolean, StreamHealth];
    this.lastCapKey = key;
    const c = this.capabilities();
    const degraded =
      rank[c.humanInput.coverage] < rank[prev[0] ?? "none"] ||
      rank[c.aiCommands.coverage] < rank[prev[1] ?? "none"] ||
      (prev[2] && !c.observer.observing) ||
      (prev[3] === "healthy" && c.stream.health !== "healthy");
    this.log.append({
      observedAt: new Date().toISOString(),
      kind: "capability_change",
      action: "capability_change",
      actor: "unknown",
      certainty: "unknown",
      evidence: [{ type: "coverage", note: reason }],
      relatedActionIds: [],
      details: {
        degraded: Boolean(degraded),
        summary: `human input: ${c.humanInput.coverage}; AI commands: ${c.aiCommands.coverage}; observing: ${c.observer.observing}; stream: ${c.stream.health} (${reason})`,
        humanInput: c.humanInput.coverage,
        aiCommands: c.aiCommands.coverage,
        observing: c.observer.observing,
        streamHealth: c.stream.health,
      },
    });
  }
}
