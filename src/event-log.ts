import { SCHEMA_VERSION, type DraftEvent, type EventSink, type TraceEvent, type Unsubscribe } from "./protocol.js";

export interface ReplayResult {
  events: TraceEvent[];
  /** Present when the caller asked for events that have already been evicted. */
  gap?: { fromSequence: number; toSequence: number; lost: number };
}

export type Listener = (event: TraceEvent) => void;

/**
 * Bounded, ordered per-session event buffer with replay.
 * Sequence numbers start at 1 and increase by exactly 1 per appended event.
 */
export class EventLog implements EventSink {
  private buf: TraceEvent[] = [];
  private nextSeq = 1;
  private listeners = new Set<Listener>();
  private dropped = 0;

  constructor(
    readonly sessionId: string,
    private readonly capacity = 5000,
  ) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
  }

  get lastSequence(): number {
    return this.nextSeq - 1;
  }
  get oldestSequence(): number | null {
    return this.buf.length ? this.buf[0].sequence : null;
  }
  get retained(): number {
    return this.buf.length;
  }
  get droppedCount(): number {
    return this.dropped;
  }
  get listenerCount(): number {
    return this.listeners.size;
  }

  append(draft: DraftEvent): TraceEvent {
    const sequence = this.nextSeq++;
    const event: TraceEvent = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: this.sessionId,
      eventId: `event-${sequence}`,
      sequence,
      ...draft,
    };
    this.buf.push(event);
    if (this.buf.length > this.capacity) {
      this.buf.shift();
      this.dropped++;
    }
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        /* a failing consumer must not break the stream for others */
      }
    }
    return event;
  }

  get(eventId: string): TraceEvent | undefined {
    return this.buf.find((e) => e.eventId === eventId);
  }

  /** All retained events with sequence > after. Reports a gap if some were evicted. */
  since(after = 0, limit = Infinity): ReplayResult {
    const oldest = this.oldestSequence;
    let gap: ReplayResult["gap"];
    if (after < this.lastSequence && oldest !== null && after + 1 < oldest) {
      gap = { fromSequence: after + 1, toSequence: oldest - 1, lost: oldest - 1 - after };
    } else if (after < this.lastSequence && oldest === null) {
      gap = { fromSequence: after + 1, toSequence: this.lastSequence, lost: this.lastSequence - after };
    }
    const events = this.buf.filter((e) => e.sequence > after).slice(0, limit);
    return { events, gap };
  }

  /** Subscribe to live events. With `fromSequence`, retained events are replayed first, in order. */
  subscribe(listener: Listener, opts: { fromSequence?: number; onGap?: (g: NonNullable<ReplayResult["gap"]>) => void } = {}): Unsubscribe {
    if (opts.fromSequence !== undefined) {
      const { events, gap } = this.since(opts.fromSequence);
      if (gap) opts.onGap?.(gap);
      for (const e of events) listener(e);
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
