import { cleanText, redactUrl, sanitizeTarget } from "./redact.js";
import type {
  Actor,
  AICommandMeta,
  BrowserObservation,
  Certainty,
  CommandStatus,
  Coverage,
  DraftEvent,
  Evidence,
  EventSink,
  HumanIntent,
  MatchStrength,
  ObservationType,
  Target,
  TraceEvent,
} from "./protocol.js";

export interface EngineOptions {
  /** How long after a human intent a matching browser event may still be explained by it. */
  humanWindowMs?: number;
  /** How long after a *completed* AI command its events may still be explained by it. Failed or cancelled commands get none. */
  aiGraceMs?: number;
  /** Tolerance for clock differences between the page and the host. */
  clockSkewMs?: number;
  pointTolerancePx?: number;
  /** How long after an input a page change may be linked to it as a probable cause. */
  linkWindowMs?: { navigation: number; mutation: number; tab: number };
  retentionMs?: number;
  now?: () => number;
}

export interface EngineHooks {
  humanCoverage: () => Coverage;
  /** Called when a trusted input arrives that no instrumented source can explain. */
  onUninstrumentedInput?: (obs: BrowserObservation) => void;
}

interface Claims {
  left: Map<ObservationType, number>;
}

interface HumanRec extends Claims {
  intent: HumanIntent;
  lastClaimedAt: number;
}

interface CommandRec extends Claims {
  actionId: string;
  meta: AICommandMeta;
  startedAt: number;
  endedAt?: number;
  status: CommandStatus;
  /** Events attributed to this command only by a weak (kind-only) match. Re-examined if the command fails. */
  weakEvents: { eventId: string; event: TraceEvent }[];
}

interface Candidate {
  source: "human" | "ai";
  id: string;
  strength: MatchStrength;
  basis: string;
  rec: HumanRec | CommandRec;
}

const INF = Number.POSITIVE_INFINITY;

const AI_DEFAULT_CLAIMS: Record<string, [ObservationType, number][]> = {
  click: [["click", 1]],
  dblclick: [["click", 2]],
  tap: [["click", 1]],
  check: [["click", 1]],
  uncheck: [["click", 1]],
  fill: [["edit", INF]],
  clear: [["edit", INF]],
  type: [["edit", INF]],
  pressSequentially: [["edit", INF]],
  select: [["edit", INF]],
  selectOption: [["edit", INF]],
  press: [
    ["edit", INF],
    ["click", 1],
  ],
  scroll: [["scroll", INF]],
  goto: [["navigation", INF]],
  navigate: [["navigation", INF]],
  reload: [["navigation", INF]],
  back: [["navigation", INF]],
  forward: [["navigation", INF]],
  open_tab: [
    ["tab_opened", 1],
    ["navigation", INF],
  ],
};

const HUMAN_DEFAULT_CLAIMS: Record<string, [ObservationType, number][]> = {
  click: [["click", 1]],
  edit: [["edit", INF]],
  scroll: [["scroll", INF]],
  navigate: [
    ["navigation", INF],
    ["tab_opened", 1],
  ],
  switch_tab: [],
};

function claimMap(pairs: [ObservationType, number][]): Map<ObservationType, number> {
  return new Map(pairs);
}

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export function compareTargets(a?: Target, b?: Target): "match" | "mismatch" | "unknown" {
  if (!a || !b) return "unknown";
  if (a.role && b.role && norm(a.role) !== norm(b.role)) return "mismatch";
  const la = norm(a.label);
  const lb = norm(b.label);
  if (la && lb) return la === lb || la.includes(lb) || lb.includes(la) ? "match" : "mismatch";
  return "unknown";
}

function normUrl(u: unknown): string {
  if (typeof u !== "string") return "";
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString().replace(/\/$/, "");
  } catch {
    return u;
  }
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export class AttributionEngine {
  private humans: HumanRec[] = [];
  private commands = new Map<string, CommandRec>();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private recentInputs: { eventId: string; at: number; tabId: string; actor: Actor; certainty: Certainty }[] = [];
  private latency: number[] = [];
  private observing = true;
  private cmdCounter = 0;

  private readonly o: Required<Omit<EngineOptions, "now">> & { now: () => number };

  constructor(
    private readonly sink: EventSink,
    private readonly hooks: EngineHooks,
    opts: EngineOptions = {},
  ) {
    this.o = {
      humanWindowMs: opts.humanWindowMs ?? 600,
      aiGraceMs: opts.aiGraceMs ?? 250,
      clockSkewMs: opts.clockSkewMs ?? 50,
      pointTolerancePx: opts.pointTolerancePx ?? 2,
      linkWindowMs: opts.linkWindowMs ?? { navigation: 1500, mutation: 400, tab: 1500 },
      retentionMs: opts.retentionMs ?? 15000,
      now: opts.now ?? Date.now,
    };
  }

  setObserving(on: boolean): void {
    this.observing = on;
  }
  get openCommandCount(): number {
    let n = 0;
    for (const c of this.commands.values()) if (c.status === "started") n++;
    return n;
  }
  get isObserving(): boolean {
    return this.observing;
  }

  latencyStats(): { samples: number; p50: number | null; p95: number | null } {
    const s = [...this.latency].sort((a, b) => a - b);
    if (!s.length) return { samples: 0, p50: null, p95: null };
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { samples: s.length, p50: q(0.5), p95: q(0.95) };
  }

  // ------------------------------------------------------------------ AI commands

  /** Record an AI command *before* it is dispatched. This proves the AI issued it, nothing more. */
  beginCommand(meta: AICommandMeta): string {
    const actionId = meta.actionId ?? `action-${++this.cmdCounter}-${Math.random().toString(36).slice(2, 7)}`;
    const startedAt = this.o.now();
    const pairs = meta.claims
      ? meta.claims.map((t): [ObservationType, number] => [t, t === "click" || t === "tab_opened" ? 1 : INF])
      : (AI_DEFAULT_CLAIMS[meta.action] ?? []);
    const rec: CommandRec = {
      actionId,
      meta: { ...meta, actionId, resolveTarget: undefined },
      startedAt,
      status: "started",
      left: claimMap(pairs),
      weakEvents: [],
    };
    this.commands.set(actionId, rec);
    this.emitCommand(rec, "started");
    return actionId;
  }

  setCommandTarget(actionId: string, target: Target | undefined): void {
    const rec = this.commands.get(actionId);
    if (rec) rec.meta = { ...rec.meta, target };
  }

  endCommand(actionId: string, status: Exclude<CommandStatus, "started">, error?: unknown): void {
    const rec = this.commands.get(actionId);
    if (!rec || rec.status !== "started") return;
    rec.status = status;
    rec.endedAt = this.o.now();
    this.emitCommand(rec, status, error);
    if (status !== "completed") this.downgradeWeakEvents(rec);
  }

  private emitCommand(rec: CommandRec, status: CommandStatus, error?: unknown): void {
    const details: Record<string, unknown> = { status, agentId: rec.meta.agentId, actionId: rec.actionId };
    if (rec.meta.url) details.url = redactUrl(rec.meta.url);
    if (error !== undefined) details.error = cleanText(error instanceof Error ? error.message : String(error), 200);
    this.sink.append({
      observedAt: new Date(this.o.now()).toISOString(),
      kind: "command",
      action: rec.meta.action,
      actor: "ai",
      certainty: "confirmed",
      tabId: rec.meta.tabId,
      target: sanitizeTarget(rec.meta.target),
      evidence: [{ type: "command_registered", actionId: rec.actionId, agentId: rec.meta.agentId }],
      relatedActionIds: [rec.actionId],
      details,
    });
  }

  private downgradeWeakEvents(rec: CommandRec): void {
    for (const { event } of rec.weakEvents) {
      const was = { actor: event.actor, certainty: event.certainty };
      this.sink.append({
        observedAt: new Date(this.o.now()).toISOString(),
        kind: "attribution_update",
        action: "reattribute",
        actor: "unknown",
        certainty: "unknown",
        relatedActionIds: [rec.actionId],
        causedBy: event.eventId,
        evidence: [
          {
            type: "downgraded",
            reason: `weak match to an AI command that later ${rec.status}`,
            was,
          },
        ],
        details: {
          updates: event.eventId,
          previous: was,
          next: { actor: "unknown", certainty: "unknown" },
        },
      });
    }
    rec.weakEvents = [];
  }

  // ------------------------------------------------------------------ human input

  /** Record input received on the instrumented human channel, before it is dispatched. */
  registerHumanIntent(intent: HumanIntent): void {
    if (intent.action === "switch_tab") {
      // Channel-only event: no browser observation is expected, the channel itself is the evidence.
      this.sink.append({
        observedAt: new Date(intent.at).toISOString(),
        kind: "input",
        action: "switch_tab",
        actor: "human",
        certainty: "confirmed",
        tabId: intent.tabId,
        evidence: [
          { type: "human_channel", channelId: intent.channelId, intentId: intent.intentId, match: "verified", basis: "channel_only" },
        ],
        relatedActionIds: [],
        details: { note: "Changes the viewed tab only; the AI's target tab is unchanged." },
      });
      return;
    }
    const pairs = intent.claims
      ? intent.claims.map((t): [ObservationType, number] => [t, t === "click" || t === "tab_opened" ? 1 : INF])
      : [...(HUMAN_DEFAULT_CLAIMS[intent.action] ?? [])];
    if (intent.keyboard && !pairs.some(([t]) => t === "click")) pairs.push(["click", 1]);
    this.humans.push({ intent, left: claimMap(pairs), lastClaimedAt: intent.at });
  }

  // ------------------------------------------------------------------ browser observations

  ingest(obs: BrowserObservation): TraceEvent | undefined {
    if (!this.observing) return undefined;
    if (this.seen.has(obs.msgId)) return undefined;
    this.seen.add(obs.msgId);
    this.seenOrder.push(obs.msgId);
    if (this.seenOrder.length > 4000) this.seen.delete(this.seenOrder.shift()!);
    this.prune();

    // Batched events (edit bursts, scroll bursts) are timed from their last underlying event, so the
    // figure reflects delivery delay including batching, not how long the user kept typing.
    const lat = this.o.now() - (num(obs.details?.lastAt) ?? obs.at);
    if (lat >= 0 && (obs.type === "click" || obs.type === "edit" || obs.type === "scroll")) {
      this.latency.push(lat);
      if (this.latency.length > 500) this.latency.shift();
    }

    switch (obs.type) {
      case "click":
      case "edit":
      case "scroll":
        return this.ingestInput(obs);
      case "navigation":
      case "tab_opened":
        if (obs.type === "navigation" && obs.details?.url === "about:blank") return undefined;
        return this.ingestChange(obs, "navigation");
      case "mutation":
      case "tab_closed":
        return this.ingestChange(obs, "observation");
    }
  }

  private ingestInput(obs: BrowserObservation): TraceEvent {
    const evidence: Evidence[] = [{ type: "browser_event", trusted: obs.trusted !== false }];
    const related: string[] = [];
    let actor: Actor = "unknown";
    let certainty: Certainty = "unknown";

    if (obs.trusted === false) {
      // The browser says a page script synthesised this event. That is a fact about the event, but
      // the script could be the page's own or something an agent injected, so it stays inferred.
      actor = "page";
      certainty = "inferred";
      evidence.push({ type: "timing_only", note: "event.isTrusted is false: dispatched by script, not by input hardware or the browser's input pipeline" });
    } else {
      const cands = this.candidates(obs);
      if (cands.length === 0) {
        const aiInFlight = this.inFlightCommands(obs);
        if (obs.type === "scroll" && aiInFlight.length) {
          // A scroll can be the side effect of an AI command (scroll-into-view). Possible, not proven.
          evidence.push({
            type: "timing_only",
            note: "scroll with no matching input source while an AI command was in flight; the command may or may not have caused it",
          });
          related.push(...aiInFlight.map((c) => c.actionId));
        } else {
          evidence.push({ type: "no_matching_source", note: "no registered AI command or human-channel input explains this event" });
          this.hooks.onUninstrumentedInput?.(obs);
        }
      } else {
        const r = this.decide(cands, obs);
        actor = r.actor;
        certainty = r.certainty;
        evidence.push(...r.evidence);
        related.push(...r.related);
      }
    }

    const ev = this.sink.append({
      observedAt: new Date(obs.at).toISOString(),
      kind: "input",
      action: obs.type,
      actor,
      certainty,
      tabId: obs.tabId,
      frameId: obs.frameId,
      documentId: obs.documentId,
      target: sanitizeTarget(obs.target),
      evidence,
      relatedActionIds: [...new Set(related)],
      details: this.safeDetails(obs),
    });

    this.noteWeakAIMatch(ev);
    if (obs.trusted !== false && (obs.type === "click" || obs.type === "edit")) {
      this.recentInputs.push({
        eventId: ev.eventId,
        at: num(obs.details?.lastAt) ?? obs.at,
        tabId: obs.tabId,
        actor,
        certainty,
      });
      if (this.recentInputs.length > 50) this.recentInputs.shift();
    }
    return ev;
  }

  /** Navigation, new tabs, DOM changes: page changes are recorded separately from the input that may have caused them. */
  private ingestChange(obs: BrowserObservation, kind: "navigation" | "observation"): TraceEvent {
    const evidence: Evidence[] = [{ type: "browser_event", trusted: obs.trusted !== false }];
    const related: string[] = [];
    let actor: Actor = "unknown";
    let certainty: Certainty = "unknown";
    let causedBy: string | undefined;

    const cands = obs.type === "navigation" || obs.type === "tab_opened" ? this.candidates(obs) : [];
    if (cands.length) {
      const r = this.decide(cands, obs);
      actor = r.actor;
      certainty = r.certainty;
      evidence.push(...r.evidence);
      related.push(...r.related);
    } else {
      const win =
        obs.type === "mutation"
          ? this.o.linkWindowMs.mutation
          : obs.type === "navigation"
            ? this.o.linkWindowMs.navigation
            : this.o.linkWindowMs.tab;
      const link = this.recentInputs
        .filter((i) => i.tabId === obs.tabId && obs.at >= i.at - this.o.clockSkewMs && obs.at - i.at <= win)
        .at(-1);
      if (link) {
        actor = "page";
        certainty = "inferred";
        causedBy = link.eventId;
        evidence.push({
          type: "causal_link",
          eventId: link.eventId,
          gapMs: Math.max(0, obs.at - link.at),
          initiatedBy: { actor: link.actor, certainty: link.certainty },
        });
      } else if (this.hooks.humanCoverage() === "full") {
        actor = "page";
        certainty = "inferred";
        evidence.push({
          type: "coverage",
          note: "no input preceded this change and the human channel is the only way to drive this browser, so it was likely initiated by the page itself",
        });
      } else {
        evidence.push({
          type: "no_matching_source",
          note: "no input explains this change and human-input coverage is limited, so the page cannot be assumed to have caused it",
        });
      }
    }

    const ev = this.sink.append({
      observedAt: new Date(obs.at).toISOString(),
      kind,
      action: obs.type === "navigation" ? "navigate" : obs.type,
      actor,
      certainty,
      tabId: obs.tabId,
      frameId: obs.frameId,
      documentId: obs.documentId,
      target: sanitizeTarget(obs.target),
      evidence,
      relatedActionIds: [...new Set(related)],
      causedBy,
      details: this.safeDetails(obs),
    });
    this.noteWeakAIMatch(ev);
    return ev;
  }

  // ------------------------------------------------------------------ candidate matching

  private inFlightCommands(obs: BrowserObservation): CommandRec[] {
    return [...this.commands.values()].filter(
      (c) =>
        c.status === "started" &&
        (!c.meta.tabId || c.meta.tabId === obs.tabId) &&
        obs.at >= c.startedAt - this.o.clockSkewMs,
    );
  }

  private candidates(obs: BrowserObservation): Candidate[] {
    const out: Candidate[] = [];

    for (const h of this.humans) {
      const left = h.left.get(obs.type);
      if (!left || left <= 0) continue;
      if (h.intent.tabId && h.intent.tabId !== obs.tabId) continue;
      const stream = left === INF;
      const end = (stream ? Math.max(h.intent.at, h.lastClaimedAt) : h.intent.at) + this.o.humanWindowMs;
      if (obs.at < h.intent.at - this.o.clockSkewMs || obs.at > end) continue;
      const m = this.matchHuman(h.intent, obs);
      if (m) out.push({ source: "human", id: h.intent.intentId, strength: m.strength, basis: m.basis, rec: h });
    }

    for (const c of this.commands.values()) {
      const left = c.left.get(obs.type);
      if (!left || left <= 0) continue;
      if (c.meta.tabId && c.meta.tabId !== obs.tabId) continue;
      const grace = c.status === "completed" ? this.o.aiGraceMs : 0;
      const end = c.endedAt === undefined ? INF : c.endedAt + grace;
      if (obs.at < c.startedAt - this.o.clockSkewMs || obs.at > end) continue;
      const m = this.matchAI(c, obs);
      if (m) out.push({ source: "ai", id: c.actionId, strength: m.strength, basis: m.basis, rec: c });
    }
    return out;
  }

  private matchHuman(i: HumanIntent, obs: BrowserObservation): { strength: MatchStrength; basis: string } | null {
    switch (obs.type) {
      case "click": {
        if (i.keyboard && !obs.point) return { strength: "weak", basis: "keyboard activation, no pointer position" };
        if (i.keyboard) return null;
        if (i.point && obs.point) {
          const d = Math.hypot(i.point.x - obs.point.x, i.point.y - obs.point.y);
          return d <= this.o.pointTolerancePx ? { strength: "verified", basis: "pointer position matches" } : null;
        }
        return this.byTarget(i.target, obs.target);
      }
      case "edit":
        return this.byTarget(i.target, obs.target);
      case "scroll": {
        const dy = num(obs.details?.dy);
        const dx = num(obs.details?.dx);
        if (i.scroll && (dy !== undefined || dx !== undefined)) {
          const agree = (a: number, b: number | undefined) => b === undefined || a === 0 || b === 0 || Math.sign(a) === Math.sign(b);
          return agree(i.scroll.dy, dy) && agree(i.scroll.dx, dx) && (dy !== 0 || dx !== 0)
            ? { strength: "verified", basis: "scroll direction matches" }
            : null;
        }
        return { strength: "weak", basis: "same kind and tab, direction unknown" };
      }
      case "navigation":
      case "tab_opened": {
        const url = obs.details?.url;
        if (i.url && typeof url === "string") {
          return normUrl(i.url) === normUrl(url) ? { strength: "verified", basis: "URL matches" } : null;
        }
        return { strength: "weak", basis: "same kind, URL unknown" };
      }
      default:
        return null;
    }
  }

  private matchAI(c: CommandRec, obs: BrowserObservation): { strength: MatchStrength; basis: string } | null {
    if (obs.type === "navigation" || obs.type === "tab_opened") {
      const url = obs.details?.url;
      if (c.meta.url && typeof url === "string") {
        return normUrl(c.meta.url) === normUrl(url)
          ? { strength: "verified", basis: "URL matches the command" }
          : { strength: "weak", basis: "URL differs from the command (redirect?)" };
      }
      return { strength: "weak", basis: "same kind, URL unknown" };
    }
    const r = this.byTarget(c.meta.target, obs.target);
    if (r) return r;
    return null;
  }

  private byTarget(a?: Target, b?: Target): { strength: MatchStrength; basis: string } | null {
    switch (compareTargets(a, b)) {
      case "match":
        return { strength: "verified", basis: "target role and label match" };
      case "mismatch":
        return null;
      default:
        return { strength: "weak", basis: "same kind and tab, target not verifiable" };
    }
  }

  private decide(
    all: Candidate[],
    obs: BrowserObservation,
  ): { actor: Actor; certainty: Certainty; evidence: Evidence[]; related: string[] } {
    const ev = (c: Candidate): Evidence =>
      c.source === "human"
        ? {
            type: "human_channel",
            channelId: (c.rec as HumanRec).intent.channelId,
            intentId: c.id,
            match: c.strength,
            basis: c.basis,
          }
        : {
            type: "ai_command",
            actionId: c.id,
            agentId: (c.rec as CommandRec).meta.agentId,
            match: c.strength,
            basis: c.basis,
          };

    // One source is one human channel or one AI command. Many keystrokes or clicks from the same
    // channel are not competing with each other: reduce each source to its best candidate first.
    const groups = new Map<string, Candidate[]>();
    for (const c of all) {
      const key = c.source === "human" ? `human:${(c.rec as HumanRec).intent.channelId}` : `ai:${c.id}`;
      const g = groups.get(key);
      if (g) g.push(c);
      else groups.set(key, [c]);
    }
    const rank = (c: Candidate) => (c.strength === "verified" ? 0 : 1);
    const reps: { rep: Candidate; members: Candidate[] }[] = [...groups.values()].map((members) => {
      members.sort((a, b) => rank(a) - rank(b) || ((a.rec as HumanRec).intent?.at ?? 0) - ((b.rec as HumanRec).intent?.at ?? 0));
      return { rep: members[0], members };
    });
    const cands = reps.map((r) => r.rep);
    const related = cands.filter((c) => c.source === "ai").map((c) => c.id);
    const competing: Evidence = {
      type: "competing_candidates",
      candidates: cands.map((c) => ({ source: c.source, id: c.id, match: c.strength })),
    };
    const verified = cands.filter((c) => c.strength === "verified");
    const actors = new Set(cands.map((c) => c.source));

    if (actors.size === 1) {
      // Every plausible source is the same kind of actor, so the actor is known even if which
      // command or channel is not. Certainty follows the best evidence.
      const best = verified[0] ?? cands[0];
      this.consume(reps.find((r) => r.rep === best)!, obs);
      return {
        actor: best.source === "human" ? "human" : "ai",
        certainty: verified.length ? "confirmed" : "inferred",
        evidence: [...cands.map(ev), ...(cands.length > 1 ? [competing] : [])],
        related,
      };
    }

    if (verified.length === 1) {
      // One candidate is verified against this very event; the others only match by kind.
      // Prefer the verified one, but competition caps certainty at "inferred".
      const c = verified[0];
      this.consume(reps.find((r) => r.rep === c)!, obs);
      return {
        actor: c.source === "human" ? "human" : "ai",
        certainty: "inferred",
        evidence: [ev(c), competing],
        related,
      };
    }

    // Human and AI are equally plausible (or neither is verified): do not guess.
    return { actor: "unknown", certainty: "unknown", evidence: [...cands.map(ev), competing], related };
  }

  private consume(g: { rep: Candidate; members: Candidate[] }, obs: BrowserObservation): void {
    const c = g.rep;
    const left = c.rec.left.get(obs.type) ?? 0;
    if (left !== INF) c.rec.left.set(obs.type, left - 1);
    if (c.source === "human") {
      // Streams (typing, scrolling) keep the whole burst alive for the sliding window.
      const at = num(obs.details?.lastAt) ?? obs.at;
      for (const m of g.members) {
        const h = m.rec as HumanRec;
        h.lastClaimedAt = Math.max(h.lastClaimedAt, at);
      }
    }
  }

  /** Called by the facade once the event for a weak AI match has been appended. */
  noteWeakAIMatch(ev: TraceEvent): void {
    for (const e of ev.evidence) {
      if (e.type === "ai_command" && e.match === "weak" && ev.actor === "ai") {
        this.commands.get(e.actionId)?.weakEvents.push({ eventId: ev.eventId, event: ev });
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  /** Whitelist of detail fields. Page-provided values never pass through verbatim. */
  private safeDetails(obs: BrowserObservation): Record<string, unknown> {
    const d = obs.details ?? {};
    const out: Record<string, unknown> = {};
    const copyNum = (k: string) => {
      const v = num(d[k]);
      if (v !== undefined) out[k] = v;
    };
    switch (obs.type) {
      case "click":
        copyNum("button");
        copyNum("clickCount");
        if (!obs.point) out.keyboardActivation = true;
        else out.point = { x: Math.round(obs.point.x), y: Math.round(obs.point.y) };
        break;
      case "edit":
        // Edit occurrence only: never the value, never the keys, never the length.
        out.edited = true;
        copyNum("count");
        if (obs.target?.sensitive) out.sensitive = true;
        break;
      case "scroll":
        copyNum("dx");
        copyNum("dy");
        copyNum("events");
        break;
      case "mutation":
        for (const k of ["added", "removed", "text", "attrs", "suppressed"]) copyNum(k);
        break;
      case "navigation":
        out.url = redactUrl(d.url);
        if (d.kind === "new_document" || d.kind === "same_document") out.navigationKind = d.kind;
        if (typeof d.previousDocumentId === "string") out.previousDocumentId = cleanText(d.previousDocumentId, 64);
        break;
      case "tab_opened":
        out.url = redactUrl(d.url);
        if (typeof d.openerTabId === "string") out.openerTabId = cleanText(d.openerTabId, 32);
        break;
    }
    if (obs.trusted === false) out.synthetic = true;
    return out;
  }

  private prune(): void {
    const now = this.o.now();
    this.humans = this.humans.filter((h) => now - Math.max(h.intent.at, h.lastClaimedAt) < this.o.humanWindowMs + this.o.retentionMs);
    for (const [id, c] of this.commands) {
      if (c.endedAt !== undefined && now - c.endedAt > this.o.retentionMs) this.commands.delete(id);
    }
  }
}
