import type { BrowserContext, Frame, Locator, Page } from "playwright-core";
import type { ActionTrace } from "../actiontrace.js";
import { buildObserverSource, describeElement, describeElementSource } from "../observer-script.js";
import type {
  BrowserAdapter,
  BrowserObservation,
  Capabilities,
  ObservationSink,
  ObservationType,
  Point,
  Target,
} from "../protocol.js";

const PAGE_MESSAGE_TYPES = new Set<ObservationType>(["click", "edit", "scroll", "mutation", "navigation"]);
const MAIN_FRAME_ONLY = new Set<ObservationType>(["mutation", "navigation"]);

export interface PlaywrightAdapterOptions {
  bindingName?: string;
}

/**
 * Observes a Playwright BrowserContext: click / edit / scroll / DOM-change / navigation events from
 * every document in every tab, with tab, frame and document identity.
 *
 * Playwright's addInitScript and exposeBinding are used as building blocks. They provide
 * observation and a channel to the host; they do not tell us who caused an event.
 */
export class PlaywrightAdapter implements BrowserAdapter {
  readonly name = "playwright";
  private sink?: ObservationSink;
  private readonly binding: string;
  private tabCounter = 0;
  private frameCounter = 0;
  private readonly tabIds = new WeakMap<Page, string>();
  private readonly pages = new Map<string, Page>();
  private readonly frameIds = new WeakMap<Frame, string>();
  private readonly quietInitialDoc = new Set<string>();
  private readonly onPage = (p: Page) => void this.trackPage(p, false);

  constructor(
    readonly context: BrowserContext,
    opts: PlaywrightAdapterOptions = {},
  ) {
    this.binding = opts.bindingName ?? "__actiontrace_" + Math.random().toString(36).slice(2, 8);
  }

  capabilities(): Capabilities["observer"] {
    return { observing: true, click: true, edit: true, scroll: true, navigation: true, mutation: true, tabs: true };
  }

  async start(sink: ObservationSink): Promise<void> {
    this.sink = sink;
    // Binding first, so the init script can capture and hide it.
    await this.context.exposeBinding(this.binding, (source, payload) => this.onMessage(source, payload));
    const content = buildObserverSource({ binding: this.binding });
    await this.context.addInitScript({ content });
    for (const p of this.context.pages()) {
      const id = this.trackPage(p, true);
      this.quietInitialDoc.add(id);
      for (const f of p.frames()) await f.evaluate(content).catch(() => undefined);
    }
    this.context.on("page", this.onPage);
  }

  async stop(): Promise<void> {
    this.context.off("page", this.onPage);
    this.sink = undefined;
  }

  // ------------------------------------------------------------------ identity helpers

  tabId(page: Page): string {
    let id = this.tabIds.get(page);
    if (!id) {
      id = `tab-${++this.tabCounter}`;
      this.tabIds.set(page, id);
      this.pages.set(id, page);
    }
    return id;
  }

  pageForTab(tabId: string): Page | undefined {
    return this.pages.get(tabId);
  }

  listTabs(): { tabId: string; url: string }[] {
    return [...this.pages.entries()].filter(([, p]) => !p.isClosed()).map(([tabId, p]) => ({ tabId, url: p.url() }));
  }

  frameId(frame: Frame): string {
    let id = this.frameIds.get(frame);
    if (!id) {
      id = `frame-${++this.frameCounter}`;
      this.frameIds.set(frame, id);
    }
    return id;
  }

  /** Describe the element a locator resolves to, using the same logic the observer uses. */
  async describe(locator: Locator, timeout = 2000): Promise<Target | undefined> {
    try {
      return (await locator.evaluate(describeElement, undefined, { timeout })) as Target;
    } catch {
      return undefined;
    }
  }

  async describeFocused(page: Page): Promise<Target | undefined> {
    try {
      return (await page.evaluate(`(() => { const a = document.activeElement; return a && a !== document.body ? (${describeElementSource})(a) : undefined; })()`)) as Target | undefined;
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------------ internals

  private trackPage(page: Page, preexisting: boolean): string {
    const id = this.tabId(page);
    if (!preexisting) {
      void (async () => {
        let opener: string | undefined;
        try {
          const o = await page.opener();
          if (o) opener = this.tabId(o);
        } catch {
          /* ignore */
        }
        this.sink?.observe({
          msgId: `${id}:opened`,
          type: "tab_opened",
          at: Date.now(),
          tabId: id,
          trusted: true,
          details: { url: page.url(), openerTabId: opener },
        });
      })();
    }
    page.once("close", () => {
      this.sink?.observe({ msgId: `${id}:closed`, type: "tab_closed", at: Date.now(), tabId: id, trusted: true });
      this.pages.delete(id);
    });
    return id;
  }

  private onMessage(source: { page: Page; frame: Frame }, raw: unknown): void {
    const sink = this.sink;
    if (!sink || !raw || typeof raw !== "object") return;
    const m = raw as Record<string, unknown>;
    const type = m.type as ObservationType;
    if (!PAGE_MESSAGE_TYPES.has(type) || typeof m.msgId !== "string") return;
    const tabId = this.tabId(source.page);
    const isMain = source.frame === source.page.mainFrame();
    if (!isMain && MAIN_FRAME_ONLY.has(type)) return;

    const details = pickDetails(m.details);
    if (type === "navigation" && details.kind === "new_document" && this.quietInitialDoc.delete(tabId)) return;

    const received = Date.now();
    // The page's clock is not trusted: clamp to a plausible window ending now.
    const at = typeof m.at === "number" && Number.isFinite(m.at) ? Math.min(received, Math.max(received - 5000, m.at)) : received;

    const obs: BrowserObservation = {
      msgId: String(m.msgId).slice(0, 80),
      type,
      at,
      tabId,
      frameId: this.frameId(source.frame),
      documentId: typeof m.documentId === "string" ? m.documentId.slice(0, 64) : undefined,
      isMainFrame: isMain,
      trusted: m.trusted === false ? false : true,
      point: pickPoint(m.point),
      target: pickTarget(m.target),
      details,
    };
    sink.observe(obs);
  }
}

function pickPoint(v: unknown): Point | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { x, y } = v as Record<string, unknown>;
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function pickTarget(v: unknown): Target | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const s = (k: string, n: number) => (typeof o[k] === "string" ? (o[k] as string).slice(0, n) : undefined);
  const t: Target = { role: s("role", 32), label: s("label", 120), tag: s("tag", 24), inputType: s("inputType", 24) };
  if (o.sensitive === true) t.sensitive = true;
  for (const k of Object.keys(t) as (keyof Target)[]) if (t[k] === undefined) delete t[k];
  return Object.keys(t).length ? t : undefined;
}

function pickDetails(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!v || typeof v !== "object") return out;
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (++n > 20) break;
    if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
    else if (typeof val === "boolean") out[k] = val;
    else if (typeof val === "string") out[k] = val.slice(0, 500);
  }
  return out;
}

/**
 * Convenience wrapper: Playwright actions that are routed through ActionTrace, with the target
 * element described automatically so the attribution engine can verify matches.
 */
export class PlaywrightAgentActions {
  constructor(
    private readonly trace: ActionTrace,
    private readonly adapter: PlaywrightAdapter,
    private readonly agentId: string,
    private readonly page: Page,
  ) {}

  private run<T>(action: string, locator: Locator | undefined, extra: { url?: string }, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.trace.runAIAction(
      {
        agentId: this.agentId,
        action,
        tabId: this.adapter.tabId(this.page),
        url: extra.url,
        signal,
        resolveTarget: locator ? () => this.adapter.describe(locator) : undefined,
      },
      fn,
    );
  }

  click(locator: Locator, opts?: { signal?: AbortSignal; timeout?: number }) {
    return this.run("click", locator, {}, () => locator.click({ timeout: opts?.timeout }), opts?.signal);
  }
  check(locator: Locator, opts?: { signal?: AbortSignal; timeout?: number }) {
    return this.run("check", locator, {}, () => locator.check({ timeout: opts?.timeout }), opts?.signal);
  }
  fill(locator: Locator, value: string, opts?: { signal?: AbortSignal; timeout?: number }) {
    return this.run("fill", locator, {}, () => locator.fill(value, { timeout: opts?.timeout }), opts?.signal);
  }
  press(locator: Locator, key: string, opts?: { signal?: AbortSignal; timeout?: number }) {
    return this.run("press", locator, {}, () => locator.press(key, { timeout: opts?.timeout }), opts?.signal);
  }
  goto(url: string, opts?: { signal?: AbortSignal }) {
    return this.run("goto", undefined, { url }, () => this.page.goto(url), opts?.signal);
  }
}
