import type { CDPSession, Page } from "playwright-core";
import { redactUrl, cleanText } from "../redact.js";
import type { Coverage, HumanInputAdapter, HumanIntentSink, Unsubscribe } from "../protocol.js";
import type { PlaywrightAdapter } from "./playwright.js";

export interface ViewerFrame {
  tabId: string;
  /** base64 JPEG */
  data: string;
  width: number;
  height: number;
}

export interface ViewerTab {
  tabId: string;
  url: string;
  title: string;
  viewed: boolean;
}

export type ViewerMessage =
  | { type: "click"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; key: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }
  | { type: "navigate"; url: string }
  | { type: "switch_tab"; tabId: string };

const MODIFIER_ONLY = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Unidentified"]);
const NAMED_KEYS = new Set([
  "Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Space",
]);

export interface ViewerAdapterOptions {
  channelId?: string;
  /**
   * Declare that this viewer is the only way a person can drive the browser (e.g. headless).
   * If a person can also use a visible browser window, set false: coverage is then "limited".
   */
  exclusive?: boolean;
  jpegQuality?: number;
}

/**
 * The instrumented human interaction surface. A remote viewer (browser tab, native app) shows the
 * shared browser and sends the person's input here. Each input is recorded as a human intent
 * *before* it is dispatched to the browser, so the attribution engine can match it to the
 * browser's own observation of the resulting event.
 */
export class ViewerAdapter implements HumanInputAdapter {
  readonly name = "viewer";
  readonly channelId: string;
  private readonly exclusive: boolean;
  private readonly quality: number;
  private sink?: HumanIntentSink;
  private viewed?: string;
  private cdp?: CDPSession;
  private cdpPage?: Page;
  private frameSubs = new Set<(f: ViewerFrame) => void>();
  private tabSubs = new Set<() => void>();
  private lastFrame?: ViewerFrame;
  private intentCounter = 0;
  private bucket = { tokens: 200, at: Date.now() };
  private readonly onPage = () => this.tabSubs.forEach((f) => f());

  constructor(
    private readonly pw: PlaywrightAdapter,
    opts: ViewerAdapterOptions = {},
  ) {
    this.channelId = opts.channelId ?? "viewer-1";
    this.exclusive = opts.exclusive ?? true;
    this.quality = opts.jpegQuality ?? 60;
  }

  coverage(): Coverage {
    return this.exclusive ? "full" : "limited";
  }

  notes(): string[] {
    return this.exclusive
      ? []
      : ["The browser may also be driven through a visible window that this channel cannot instrument."];
  }

  async start(sink: HumanIntentSink): Promise<void> {
    this.sink = sink;
    this.pw.context.on("page", this.onPage);
    const first = this.pw.context.pages()[0];
    if (first) await this.showTab(this.pw.tabId(first), false);
  }

  async stop(): Promise<void> {
    this.pw.context.off("page", this.onPage);
    await this.stopCast();
    this.sink = undefined;
  }

  // ------------------------------------------------------------------ viewer-facing API

  onFrame(cb: (f: ViewerFrame) => void): Unsubscribe {
    this.frameSubs.add(cb);
    if (this.lastFrame) cb(this.lastFrame);
    void this.requestFrame();
    return () => this.frameSubs.delete(cb);
  }

  onTabsChanged(cb: () => void): Unsubscribe {
    this.tabSubs.add(cb);
    return () => this.tabSubs.delete(cb);
  }

  async tabs(): Promise<ViewerTab[]> {
    const out: ViewerTab[] = [];
    for (const t of this.pw.listTabs()) {
      const p = this.pw.pageForTab(t.tabId);
      let title = "";
      try {
        title = p ? cleanText(await p.title(), 60) : "";
      } catch {
        /* page closing */
      }
      out.push({ tabId: t.tabId, url: redactUrl(t.url), title, viewed: t.tabId === this.viewed });
    }
    return out;
  }

  get viewedTab(): string | undefined {
    return this.viewed;
  }

  /** Receive a message from a viewer. Input is validated, recorded as an intent, then dispatched. */
  async handle(raw: unknown): Promise<void> {
    if (!this.sink || !raw || typeof raw !== "object" || !this.allow()) return;
    const m = raw as Record<string, unknown>;
    const tabId = this.viewed;
    const page = tabId ? this.pw.pageForTab(tabId) : undefined;
    const at = Date.now();
    const intentId = `${this.channelId}-${++this.intentCounter}`;
    const base = { intentId, channelId: this.channelId, at, tabId };
    const size = page?.viewportSize() ?? { width: 1280, height: 720 };
    const inView = (x: unknown, y: unknown): x is number =>
      typeof x === "number" && typeof y === "number" && x >= 0 && y >= 0 && x <= size.width && y <= size.height;

    try {
      switch (m.type) {
        case "click": {
          if (!page || !inView(m.x, m.y)) return;
          const x = m.x as number, y = m.y as number;
          this.sink.recordIntent({ ...base, action: "click", point: { x, y } });
          await page.mouse.click(x, y);
          return;
        }
        case "scroll": {
          if (!page || !inView(m.x, m.y)) return;
          const dx = clampNum(m.dx), dy = clampNum(m.dy);
          if (!dx && !dy) return;
          this.sink.recordIntent({ ...base, action: "scroll", point: { x: m.x as number, y: m.y as number }, scroll: { dx, dy } });
          await page.mouse.move(m.x as number, m.y as number);
          await page.mouse.wheel(dx, dy);
          return;
        }
        case "key": {
          if (!page || typeof m.key !== "string") return;
          const key = m.key === " " ? "Space" : m.key;
          if (MODIFIER_ONLY.has(key)) return;
          if (!(key.length === 1 || NAMED_KEYS.has(key))) return;
          const combo = [m.ctrl && "Control", m.meta && "Meta", m.alt && "Alt", m.shift && key.length > 1 && "Shift", key].filter(Boolean).join("+");
          // The element that will receive the key is the evidence; the key itself is never recorded.
          const target = await this.pw.describeFocused(page);
          if (target) this.sink.recordIntent({ ...base, at: Date.now(), action: "edit", target, keyboard: true });
          await page.keyboard.press(combo);
          return;
        }
        case "navigate": {
          if (!page || typeof m.url !== "string") return;
          let url: URL;
          try {
            url = new URL(m.url.includes("://") ? m.url : "https://" + m.url);
          } catch {
            return;
          }
          if (url.protocol !== "http:" && url.protocol !== "https:") return;
          this.sink.recordIntent({ ...base, action: "navigate", url: url.toString() });
          await page.goto(url.toString()).catch(() => undefined);
          return;
        }
        case "switch_tab": {
          if (typeof m.tabId !== "string" || !this.pw.pageForTab(m.tabId)) return;
          this.sink.recordIntent({ ...base, action: "switch_tab", tabId: m.tabId });
          await this.showTab(m.tabId, true);
          return;
        }
      }
    } catch {
      /* the page closed or navigated away mid-dispatch; the intent simply goes unclaimed */
    }
  }

  // ------------------------------------------------------------------ screencast

  private allow(): boolean {
    const now = Date.now();
    this.bucket.tokens = Math.min(200, this.bucket.tokens + ((now - this.bucket.at) / 1000) * 200);
    this.bucket.at = now;
    if (this.bucket.tokens < 1) return false;
    this.bucket.tokens--;
    return true;
  }

  private async showTab(tabId: string, notify: boolean): Promise<void> {
    const page = this.pw.pageForTab(tabId);
    if (!page) return;
    this.viewed = tabId;
    await this.startCast(page, tabId);
    if (notify) this.tabSubs.forEach((f) => f());
    await this.requestFrame();
  }

  private async startCast(page: Page, tabId: string): Promise<void> {
    if (this.cdpPage === page) return;
    await this.stopCast();
    try {
      const cdp = await this.pw.context.newCDPSession(page);
      this.cdp = cdp;
      this.cdpPage = page;
      cdp.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
        const size = page.viewportSize() ?? { width: 1280, height: 720 };
        this.emitFrame({ tabId, data: ev.data, width: size.width, height: size.height });
        cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => undefined);
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: this.quality, everyNthFrame: 1 });
    } catch {
      // Screencast is Chromium-only. Fall back to on-demand screenshots (requestFrame).
    }
  }

  private async stopCast(): Promise<void> {
    try {
      await this.cdp?.send("Page.stopScreencast");
      await this.cdp?.detach();
    } catch {
      /* ignore */
    }
    this.cdp = undefined;
    this.cdpPage = undefined;
  }

  private emitFrame(f: ViewerFrame): void {
    this.lastFrame = f;
    for (const cb of this.frameSubs) cb(f);
  }

  /** Push one fresh frame (used when a viewer connects or the tab changes). */
  async requestFrame(): Promise<void> {
    const tabId = this.viewed;
    const page = tabId ? this.pw.pageForTab(tabId) : undefined;
    if (!page || !tabId || page.isClosed()) return;
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: this.quality });
      const size = page.viewportSize() ?? { width: 1280, height: 720 };
      this.emitFrame({ tabId, data: buf.toString("base64"), width: size.width, height: size.height });
    } catch {
      /* page navigating */
    }
  }
}

function clampNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(-2000, Math.min(2000, v)) : 0;
}
