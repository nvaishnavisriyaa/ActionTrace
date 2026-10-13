/**
 * ActionTrace event protocol (schema version 1.0).
 *
 * Two independent fields describe ownership:
 *   actor     - who produced the record: human | ai | page | unknown
 *   certainty - confirmed | inferred | unknown
 *
 * Records that are not about an actor's behaviour (capability_change, stream_gap,
 * attribution_update) use actor "unknown" / certainty "unknown"; `kind` tells them apart.
 */

export const SCHEMA_VERSION = "1.0" as const;

export type Actor = "human" | "ai" | "page" | "unknown";
export type Certainty = "confirmed" | "inferred" | "unknown";

export type EventKind =
  | "input" // a click / edit / scroll that someone performed
  | "navigation" // a document or URL change (a page change, never an input)
  | "observation" // other page-side changes: DOM mutation, tab opened/closed
  | "command" // AI command lifecycle
  | "attribution_update" // an earlier record was re-attributed
  | "capability_change" // coverage / health of the integration changed
  | "stream_gap"; // the consumer asked for events that are no longer retained

export interface Target {
  role?: string;
  label?: string;
  tag?: string;
  inputType?: string;
  /** True for password / payment-like fields. Their values are never captured. */
  sensitive?: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export type MatchStrength = "verified" | "weak";

export type Evidence =
  | { type: "human_channel"; channelId: string; intentId: string; match: MatchStrength; basis: string }
  | { type: "ai_command"; actionId: string; agentId: string; match: MatchStrength; basis: string }
  | { type: "browser_event"; trusted: boolean }
  | { type: "competing_candidates"; candidates: { source: "human" | "ai"; id: string; match: MatchStrength }[] }
  | { type: "no_matching_source"; note: string }
  | { type: "causal_link"; eventId: string; gapMs: number; initiatedBy: { actor: Actor; certainty: Certainty } }
  | { type: "timing_only"; note: string }
  | { type: "command_registered"; actionId: string; agentId: string }
  | { type: "coverage"; note: string }
  | { type: "downgraded"; reason: string; was: { actor: Actor; certainty: Certainty } };

export interface TraceEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  sessionId: string;
  eventId: string;
  /** Strictly increasing per session. Ordering across independent sources is best-effort. */
  sequence: number;
  observedAt: string; // ISO-8601
  kind: EventKind;
  action: string;
  actor: Actor;
  certainty: Certainty;
  tabId?: string;
  frameId?: string;
  documentId?: string;
  target?: Target;
  evidence: Evidence[];
  relatedActionIds: string[];
  /** eventId of the input that probably caused this page change. Optional, never implies ownership. */
  causedBy?: string;
  details?: Record<string, unknown>;
}

export type DraftEvent = Omit<TraceEvent, "schemaVersion" | "sessionId" | "eventId" | "sequence">;

/** Where drafts go. The EventLog implements this; the engine never assigns sequence numbers itself. */
export interface EventSink {
  append(draft: DraftEvent): TraceEvent;
}

// ---------------------------------------------------------------------------
// Raw inputs to the attribution engine
// ---------------------------------------------------------------------------

export type ObservationType = "click" | "edit" | "scroll" | "mutation" | "navigation" | "tab_opened" | "tab_closed";

/** What the browser observer saw. Contains no actor information by construction. */
export interface BrowserObservation {
  /** Unique per message; used for deduplication. */
  msgId: string;
  type: ObservationType;
  /** Epoch ms of the (first) underlying browser event. */
  at: number;
  tabId: string;
  frameId?: string;
  documentId?: string;
  isMainFrame?: boolean;
  /** `Event.isTrusted`. False means a page script synthesised the event. */
  trusted?: boolean;
  point?: Point;
  target?: Target;
  details?: Record<string, unknown>;
}

export type HumanIntentAction = "click" | "edit" | "scroll" | "navigate" | "switch_tab";

/** Input received through the instrumented human channel, recorded before it reaches the browser. */
export interface HumanIntent {
  intentId: string;
  channelId: string;
  action: HumanIntentAction;
  at: number;
  tabId?: string;
  point?: Point;
  target?: Target;
  /** Scroll direction, used to verify scroll observations. */
  scroll?: { dx: number; dy: number };
  url?: string;
  /** Observation types this intent may explain. Defaults are derived from `action`. */
  claims?: ObservationType[];
  /** Keyboard activation (Enter on a button) explains a click that has no pointer position. */
  keyboard?: boolean;
}

export type CommandStatus = "started" | "completed" | "failed" | "cancelled";

export interface AICommandMeta {
  agentId: string;
  /** click | fill | type | press | check | select | scroll | goto | evaluate | ... */
  action: string;
  actionId?: string;
  tabId?: string;
  target?: Target;
  url?: string;
  /** Override which observation types this command may explain. */
  claims?: ObservationType[];
  /**
   * Resolve the target element after the command is recorded but before it is dispatched.
   * If resolution fails the command is still recorded; it just has no verifiable target.
   */
  resolveTarget?: () => Promise<Target | undefined>;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type Coverage = "full" | "limited" | "none";
export type StreamHealth = "healthy" | "degraded" | "disconnected";

export interface Capabilities {
  humanInput: { coverage: Coverage; channels: string[]; notes: string[] };
  aiCommands: { coverage: Coverage; notes: string[] };
  observer: {
    observing: boolean;
    click: boolean;
    edit: boolean;
    scroll: boolean;
    navigation: boolean;
    mutation: boolean;
    tabs: boolean;
  };
  stream: {
    health: StreamHealth;
    consumers: number;
    oldestSequence: number | null;
    lastSequence: number;
    retained: number;
    dropped: number;
    latencyMs: { samples: number; p50: number | null; p95: number | null };
  };
}

// ---------------------------------------------------------------------------
// Adapter contracts
// ---------------------------------------------------------------------------

export interface ObservationSink {
  observe(obs: BrowserObservation): void;
}

export interface HumanIntentSink {
  recordIntent(intent: HumanIntent): void;
}

export interface BrowserAdapter {
  readonly name: string;
  capabilities(): Capabilities["observer"];
  start(sink: ObservationSink): Promise<void>;
  stop(): Promise<void>;
}

export interface HumanInputAdapter {
  readonly name: string;
  readonly channelId: string;
  /**
   * "full" means this channel is the only way a person can drive this browser (e.g. a headless
   * browser exposed through a viewer). "limited" means other input paths may exist.
   */
  coverage(): Coverage;
  notes?(): string[];
  start(sink: HumanIntentSink): Promise<void>;
  stop(): Promise<void>;
}

export type Unsubscribe = () => void;
