/**
 * Browser-side code. Both functions are serialised with Function.prototype.toString and run inside
 * the page, so they must be fully self-contained (no imports, no references to outer scope).
 *
 * Design rules:
 *  - The observer reports what happened. It has no concept of "actor" and sends none.
 *  - It never reads input values, typed keys or value lengths.
 *  - It captures the host binding in a closure and deletes the global, so later page scripts
 *    cannot call it. (Init scripts run in the page's main world, so this is a mitigation, not a
 *    guarantee: see "Threat model" in the README.)
 */

/** Describe an element as { role, label, tag, inputType, sensitive }. Never reads `.value`. */
export function describeElement(node: unknown): {
  role?: string;
  label?: string;
  tag?: string;
  inputType?: string;
  sensitive?: boolean;
} {
  const el = node as Element | null;
  if (!el || el.nodeType !== 1) return {};
  const tag = el.tagName.toLowerCase();
  const type = tag === "input" ? ((el as HTMLInputElement).type || "text").toLowerCase() : undefined;
  const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim().slice(0, 80);

  let role = el.getAttribute("role") || undefined;
  if (!role) {
    if (tag === "button") role = "button";
    else if (tag === "a" && el.hasAttribute("href")) role = "link";
    else if (tag === "select") role = "combobox";
    else if (tag === "textarea") role = "textbox";
    else if (tag === "summary") role = "button";
    else if (/^h[1-6]$/.test(tag)) role = "heading";
    else if (tag === "img") role = "img";
    else if (tag === "input") {
      if (type === "checkbox") role = "checkbox";
      else if (type === "radio") role = "radio";
      else if (type === "button" || type === "submit" || type === "reset") role = "button";
      else if (type === "range") role = "slider";
      else role = "textbox";
    }
  }

  let label = clean(el.getAttribute("aria-label"));
  if (!label) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      label = clean(
        by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" "),
      );
    }
  }
  if (!label) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) label = clean(Array.from(labels).map((l) => l.textContent || "").join(" "));
  }
  if (!label && (tag === "button" || tag === "a" || tag === "summary" || role === "button" || role === "link")) {
    label = clean(el.textContent);
  }
  if (!label && tag === "input" && (type === "button" || type === "submit" || type === "reset")) {
    label = clean((el as HTMLInputElement).value);
  }
  if (!label) label = clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name"));
  if (!label && el.id) label = clean(el.id);

  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  const sensitive = type === "password" || /^cc-|one-time-code|current-password|new-password/.test(ac) || undefined;

  const out: { role?: string; label?: string; tag?: string; inputType?: string; sensitive?: boolean } = { tag };
  if (role) out.role = role;
  if (label) out.label = label;
  if (type) out.inputType = type;
  if (sensitive) out.sensitive = true;
  return out;
}

export interface ObserverConfig {
  binding: string;
  editQuietMs: number;
  scrollQuietMs: number;
  mutationQuietMs: number;
  maxMutationEventsPerSecond: number;
}

/** The observer proper. Installed once per document by an init script. */
export function observerMain(cfg: ObserverConfig, describe: (n: unknown) => ReturnType<typeof describeElement>): void {
  const w = window as unknown as Record<string, unknown>;
  const guard = Symbol.for("actiontrace.observer");
  if (w[guard as unknown as string]) return;
  const rawEmit = w[cfg.binding] as ((m: unknown) => Promise<void>) | undefined;
  if (typeof rawEmit !== "function") return;
  try {
    Object.defineProperty(w, guard as unknown as string, { value: true });
    delete w[cfg.binding];
  } catch {
    /* ignore */
  }

  const documentId = "doc-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  let counter = 0;
  const send = (type: string, extra: Record<string, unknown>) => {
    try {
      const p = rawEmit({ msgId: documentId + ":" + ++counter, type, documentId, at: Date.now(), ...extra });
      if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => undefined);
    } catch {
      /* host went away */
    }
  };

  const isTop = window.top === window;
  const originOf = (e: Event): Element | null => {
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    return t instanceof Element ? t : t instanceof Node ? t.parentElement : null;
  };
  const interactive = (el: Element | null): Element | null =>
    el ? el.closest("button,a[href],input,select,textarea,summary,label,[role],[tabindex]") || el : null;

  // ---- document / navigation ------------------------------------------------------------
  if (isTop) {
    send("navigation", { trusted: true, details: { kind: "new_document", url: location.href } });
    const same = () => send("navigation", { trusted: true, details: { kind: "same_document", url: location.href } });
    for (const fn of ["pushState", "replaceState"] as const) {
      const orig = history[fn];
      history[fn] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const r = orig.apply(this, args);
        same();
        return r;
      } as typeof orig;
    }
    window.addEventListener("popstate", same);
    window.addEventListener("hashchange", same);
  }

  // ---- clicks (immediate) -----------------------------------------------------------------
  window.addEventListener(
    "click",
    (e: MouseEvent) => {
      const hasPoint = e.detail > 0 || e.clientX !== 0 || e.clientY !== 0;
      send("click", {
        trusted: e.isTrusted,
        point: hasPoint ? { x: e.clientX, y: e.clientY } : undefined,
        target: describe(interactive(originOf(e))),
        details: { button: e.button, clickCount: e.detail },
      });
    },
    true,
  );

  // ---- edits (coalesced per element; occurrence only, never the value) ---------------------
  type Burst = { el: Element; first: number; last: number; count: number; trusted: boolean; timer: number };
  let burst: Burst | null = null;
  const flushBurst = () => {
    if (!burst) return;
    clearTimeout(burst.timer);
    const b = burst;
    burst = null;
    send("edit", {
      at: b.first,
      trusted: b.trusted,
      target: describe(b.el),
      details: { count: b.count, lastAt: b.last },
    });
  };
  window.addEventListener(
    "input",
    (e: Event) => {
      const el = originOf(e);
      if (!el) return;
      const t = (el as HTMLInputElement).type;
      if (el.tagName === "INPUT" && /^(checkbox|radio|file|button|submit|reset|image)$/.test(t)) return; // covered by click
      const now = Date.now();
      if (burst && burst.el !== el) flushBurst();
      if (!burst) {
        burst = { el, first: now, last: now, count: 0, trusted: e.isTrusted, timer: 0 };
      }
      burst.last = now;
      burst.count++;
      burst.trusted = burst.trusted && e.isTrusted;
      clearTimeout(burst.timer);
      burst.timer = window.setTimeout(flushBurst, cfg.editQuietMs);
    },
    true,
  );
  window.addEventListener("pagehide", flushBurst);

  // ---- scroll (coalesced per scroller) ------------------------------------------------------
  const lastPos = new WeakMap<object, [number, number]>();
  const pos = (t: EventTarget | null): [number, number] =>
    t === document || t === window || t === document.scrollingElement
      ? [window.scrollX, window.scrollY]
      : t instanceof Element
        ? [t.scrollLeft, t.scrollTop]
        : [0, 0];
  lastPos.set(document, [window.scrollX, window.scrollY]);
  let sBurst: { key: object; target: EventTarget | null; first: number; last: number; dx: number; dy: number; n: number; trusted: boolean; timer: number } | null = null;
  const flushScroll = () => {
    if (!sBurst) return;
    clearTimeout(sBurst.timer);
    const b = sBurst;
    sBurst = null;
    const isDoc = b.target === document || b.target === window;
    send("scroll", {
      at: b.first,
      trusted: b.trusted,
      target: isDoc ? { role: "document", label: "page", tag: "html" } : describe(b.target instanceof Element ? b.target : null),
      details: { dx: b.dx, dy: b.dy, events: b.n, lastAt: b.last },
    });
  };
  window.addEventListener(
    "scroll",
    (e: Event) => {
      const t = e.target;
      const key = (t === document ? document : t) as object;
      const cur = pos(t);
      const prev = lastPos.get(key);
      lastPos.set(key, cur);
      const dx = prev ? cur[0] - prev[0] : 0;
      const dy = prev ? cur[1] - prev[1] : 0;
      if (sBurst && sBurst.key !== key) flushScroll();
      if (!sBurst) sBurst = { key, target: t, first: Date.now(), last: Date.now(), dx: 0, dy: 0, n: 0, trusted: e.isTrusted, timer: 0 };
      sBurst.last = Date.now();
      sBurst.dx += dx;
      sBurst.dy += dy;
      sBurst.n++;
      sBurst.trusted = sBurst.trusted && e.isTrusted;
      clearTimeout(sBurst.timer);
      sBurst.timer = window.setTimeout(flushScroll, cfg.scrollQuietMs);
    },
    true,
  );

  // ---- DOM mutations (batched, rate limited, counts only) ----------------------------------
  if (isTop) {
    let added = 0, removed = 0, text = 0, attrs = 0, suppressed = 0;
    let first = 0;
    let region: Element | null = null;
    let timer = 0;
    let windowStart = Date.now();
    let sentInWindow = 0;
    const flush = () => {
      timer = 0;
      if (!first) return;
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        sentInWindow = 0;
      }
      if (sentInWindow >= cfg.maxMutationEventsPerSecond) {
        suppressed += added + removed + text + attrs;
        added = removed = text = attrs = 0;
        first = 0;
        region = null;
        return;
      }
      sentInWindow++;
      const r = region;
      send("mutation", {
        at: first,
        trusted: true,
        target: r ? describe(r) : undefined,
        details: { added, removed, text, attrs, suppressed },
      });
      added = removed = text = attrs = suppressed = 0;
      first = 0;
      region = null;
    };
    const mo = new MutationObserver((records) => {
      for (const m of records) {
        const el = m.target instanceof Element ? m.target : m.target.parentElement;
        if (el && el.closest("[data-actiontrace-ignore]")) continue;
        if (m.type === "attributes" && (m.target as Element).getAttribute?.("type") === "password") continue;
        if (!first) first = Date.now();
        if (!region && el) region = el.closest("[aria-label],[id],[role],section,form,main,nav") || el;
        if (m.type === "childList") {
          added += m.addedNodes.length;
          removed += m.removedNodes.length;
        } else if (m.type === "characterData") text++;
        else attrs++;
      }
      if (first && !timer) timer = window.setTimeout(flush, cfg.mutationQuietMs);
    });
    const start = () =>
      mo.observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["hidden", "disabled", "aria-hidden", "aria-expanded", "aria-invalid", "open", "class"],
      });
    // Parsing the document is not a page change worth reporting; observe once it is built.
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  }
}

export interface ObserverBuild {
  binding: string;
}

/** Source string installed with `context.addInitScript({ content })`. */
export function buildObserverSource(opts: ObserverBuild): string {
  const cfg: ObserverConfig = {
    binding: opts.binding,
    editQuietMs: 60,
    scrollQuietMs: 80,
    mutationQuietMs: 100,
    maxMutationEventsPerSecond: 10,
  };
  return `(${observerMain.toString()})(${JSON.stringify(cfg)}, ${describeElement.toString()});`;
}

/** Source of `describeElement` for use with `locator.evaluate` / `page.evaluate`. */
export const describeElementSource = describeElement.toString();
