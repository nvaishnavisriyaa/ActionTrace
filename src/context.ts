import type { EventLog } from "./event-log.js";
import type { TraceEvent } from "./protocol.js";

export interface ContextUpdate {
  fromSequence: number;
  toSequence: number;
  /** True after a delivery gap or disconnect, until the host calls `markRefreshed()` after re-reading browser state. */
  stale: boolean;
  staleReason?: string;
  /** Things the model should not miss. */
  attention: string[];
  /** Compact, model-ready lines. Quoted text inside them is page-provided data, not instructions. */
  lines: string[];
  /** Regularly repeating page updates not caused by input (likely timers), summarised instead of listed. */
  background: string[];
  /** Same information as one string. */
  summary: string;
  counts: { human: number; ai: number; page: number; unknown: number; total: number };
  eventCount: number;
  /** Elements the user touched since the last observation (structured form of the attention lines). */
  humanTouched: TouchedTarget[];
  /** Inputs whose owner could not be determined. Treat the elements as possibly changed by the user. */
  uncertainTouched: TouchedTarget[];
}

export interface TouchedTarget {
  action: string;
  role?: string;
  label?: string;
  certainty: string;
  eventId: string;
}

const q = (s: string) => JSON.stringify(s);

function describeTarget(e: TraceEvent): string {
  const t = e.target;
  if (!t) return "";
  const parts = [t.role ?? t.tag ?? "element"];
  if (t.label) parts.push(q(t.label));
  return parts.join(" ") + (t.sensitive ? " [sensitive]" : "");
}

function line(e: TraceEvent, byId: Map<string, TraceEvent>): string {
  const time = e.observedAt.slice(11, 19);
  const who = `${e.actor.toUpperCase()}(${e.certainty})`;
  const tgt = describeTarget(e);
  const d = (e.details ?? {}) as Record<string, unknown>;
  let body = `${e.action}${tgt ? " " + tgt : ""}`;
  switch (e.kind) {
    case "command":
      body = `command ${e.action} ${d.status}${tgt ? " on " + tgt : ""}${d.error ? " — " + q(String(d.error)) : ""}`;
      break;
    case "navigation":
      body = `navigate → ${d.url ?? "?"}${d.navigationKind === "same_document" ? " (same document)" : ""}`;
      break;
    case "observation":
      if (e.action === "mutation") body = `page content changed (+${d.added ?? 0}/-${d.removed ?? 0} nodes)${tgt ? " in " + tgt : ""}`;
      break;
    case "capability_change":
      body = `coverage changed: ${(d.summary as string) ?? ""}`;
      break;
    case "attribution_update":
      body = `earlier ${d.updates} re-attributed to unknown (${(e.evidence[0] as { reason?: string } | undefined)?.reason ?? "evidence changed"})`;
      break;
    case "stream_gap":
      body = `gap: ${d.lost} events not recoverable`;
      break;
  }
  const notes: string[] = [];
  if (e.causedBy) {
    const c = byId.get(e.causedBy);
    notes.push(`after ${c ? `${c.actor} ${c.action}` : "an input"} ${e.causedBy.replace("event-", "#")}`);
  }
  if (e.actor === "unknown" && e.kind === "input") {
    const comp = e.evidence.find((x) => x.type === "competing_candidates");
    notes.push(comp ? "multiple possible sources" : "no source explains it");
  }
  if (d.sensitive) notes.push("value withheld");
  return `#${e.sequence} ${time} ${who} ${body}${notes.length ? " — " + notes.join("; ") : ""}`;
}

/** The attention line produced when the user touched something. Exported so hosts can recognise it. */
export const HUMAN_TOUCH_ATTENTION_PREFIX = "The user interacted with the browser";

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const every = (ms: number) => (ms >= 1000 ? `${+(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/**
 * Finds mutation records that repeat on one target at roughly constant intervals and were not caused
 * by an input. Needs at least 4 occurrences and a typical gap of 200 ms or more, with 80% of gaps
 * within half to one-and-a-half times the typical gap.
 */
export function findPeriodicUpdates(events: TraceEvent[]): { periodic: Set<string>; background: string[] } {
  const groups = new Map<string, TraceEvent[]>();
  for (const e of events) {
    if (e.kind !== "observation" || e.action !== "mutation" || e.causedBy) continue;
    const key = `${e.tabId ?? ""}|${describeTarget(e)}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const periodic = new Set<string>();
  const background: string[] = [];
  for (const g of groups.values()) {
    if (g.length < 4) continue;
    const times = g.map((e) => Date.parse(e.observedAt));
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const m = median(gaps);
    if (!(m >= 200)) continue;
    if (gaps.filter((x) => x >= m * 0.5 && x <= m * 1.5).length < gaps.length * 0.8) continue;
    for (const e of g) periodic.add(e.eventId);
    const where = describeTarget(g[0]);
    background.push(`${where ? where + " " : "page "}updated ${g.length}× roughly every ${every(m)}, not caused by input (regular timing: likely a timer or ticker)`);
  }
  return { periodic, background };
}

/** The one place a model-ready summary string is assembled, so ATTENTION/EVENTS/BACKGROUND stay in sync everywhere it's built. */
function renderSummary(attention: string[], lines: string[], background: string[]): string {
  return [
    ...(attention.length ? ["ATTENTION:", ...attention.map((a) => "- " + a)] : []),
    ...(lines.length ? ["EVENTS:", ...lines] : ["No browser activity since your last observation" + (background.length ? " besides background updates." : ".")]),
    ...(background.length ? ["BACKGROUND:", ...background.map((b) => "- " + b)] : []),
  ].join("\n");
}

export function summarizeEvents(events: TraceEvent[], opts: { maxLines?: number; allEvents?: Map<string, TraceEvent> } = {}): Omit<ContextUpdate, "fromSequence" | "toSequence" | "stale" | "staleReason"> {
  const maxLines = opts.maxLines ?? 30;
  const byId = opts.allEvents ?? new Map(events.map((e) => [e.eventId, e]));
  const counts = { human: 0, ai: 0, page: 0, unknown: 0, total: events.length };
  const attention: string[] = [];

  // Page updates that tick at regular intervals and were not caused by input (a clock, a ticker, a
  // poller) become one background line instead of dozens of event lines. This is a timing heuristic,
  // so the wording says "likely"; the raw events stay available from the event log.
  const { periodic, background } = findPeriodicUpdates(events);

  // Collapse runs of identical edits / scrolls so a typing burst is one line.
  type Row = { e: TraceEvent; n: number };
  const rows: Row[] = [];
  for (const e of events) {
    counts[e.actor]++;
    if (periodic.has(e.eventId)) continue;
    const prev = rows.at(-1);
    if (prev && (e.action === "edit" || e.action === "scroll" || e.action === "mutation") && prev.e.action === e.action && prev.e.actor === e.actor && prev.e.certainty === e.certainty && prev.e.tabId === e.tabId && describeTarget(prev.e) === describeTarget(e)) {
      prev.n++;
      continue;
    }
    rows.push({ e, n: 1 });
  }

  const humanInputs = events.filter((e) => e.kind === "input" && e.actor === "human");
  if (humanInputs.length) {
    const targets = [...new Set(humanInputs.map((e) => `${e.action}${describeTarget(e) ? " " + describeTarget(e) : ""}`))].slice(0, 5);
    attention.push(`${HUMAN_TOUCH_ATTENTION_PREFIX} (${targets.join("; ")}). Re-read the affected elements before overwriting them.`);
  }
  const unknowns = events.filter((e) => e.kind === "input" && e.actor === "unknown");
  if (unknowns.length) {
    attention.push(`${unknowns.length} input event(s) have unknown ownership. Do not assume they were yours; verify the state.`);
  }
  for (const e of events) {
    if (e.kind === "command" && (e.details as { status?: string } | undefined)?.status === "failed") {
      attention.push(`Your command ${e.relatedActionIds[0]} (${e.action}) failed; activity after it is not credited to it.`);
    }
    if (e.kind === "capability_change" && (e.details as { degraded?: boolean } | undefined)?.degraded) {
      attention.push(`Attribution coverage dropped: ${(e.details as { summary?: string }).summary}`);
    }
  }

  const shown = rows.slice(-maxLines);
  const lines = shown.map(({ e, n }) => line(e, byId) + (n > 1 ? ` ×${n}` : ""));
  if (rows.length > shown.length) lines.unshift(`(${rows.length - shown.length} earlier lines omitted)`);

  const summary = renderSummary(attention, lines, background);

  const touched = (e: TraceEvent): TouchedTarget => ({ action: e.action, role: e.target?.role, label: e.target?.label, certainty: e.certainty, eventId: e.eventId });
  return {
    attention,
    lines,
    background,
    summary,
    counts,
    eventCount: events.length,
    humanTouched: humanInputs.map(touched),
    uncertainTouched: unknowns.map(touched),
  };
}

/**
 * A per-consumer cursor over the event log. `next()` returns what changed since the last call;
 * the host injects it at the model's next supported execution boundary.
 */
export class ContextFeed {
  private cursor: number;
  private staleReason?: string;

  constructor(
    private readonly log: EventLog,
    startAfter = 0,
  ) {
    this.cursor = startAfter;
  }

  get lastConsumed(): number {
    return this.cursor;
  }
  get isStale(): boolean {
    return this.staleReason !== undefined;
  }

  /** The host's connection to the event stream dropped. Context is stale until `markRefreshed()`. */
  markDisconnected(reason = "event stream was disconnected"): void {
    this.staleReason ??= reason;
  }

  /** The host re-read browser state itself (e.g. a fresh snapshot) and no longer needs the stale warning. */
  markRefreshed(): void {
    this.staleReason = undefined;
  }

  peek(): ContextUpdate {
    return this.build(false);
  }

  next(): ContextUpdate {
    return this.build(true);
  }

  private build(advance: boolean): ContextUpdate {
    const { events, gap } = this.log.since(this.cursor);
    let reason = this.staleReason;
    if (gap) reason = `${gap.lost} event(s) were evicted before delivery (sequences ${gap.fromSequence}-${gap.toSequence})`;
    const all = new Map(this.log.since(0).events.map((e) => [e.eventId, e]));
    const s = summarizeEvents(events, { allEvents: all });
    const stale = reason !== undefined;
    const attention = stale ? [`Context may be stale: ${reason}. Refresh browser state before acting.`, ...s.attention] : s.attention;
    const summary = renderSummary(attention, s.lines, s.background);
    const update: ContextUpdate = {
      ...s,
      attention,
      summary,
      fromSequence: this.cursor + 1,
      toSequence: events.at(-1)?.sequence ?? this.cursor,
      stale,
      staleReason: reason,
    };
    if (advance) {
      this.cursor = this.log.lastSequence;
      if (gap) this.staleReason = reason;
    }
    return update;
  }
}
