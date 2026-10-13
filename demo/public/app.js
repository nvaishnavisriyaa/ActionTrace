// ActionTrace demo UI. Everything from the page or the event stream is rendered with textContent only.
const hash = new URLSearchParams(location.hash.slice(1));
const sid = hash.get("sid");
const ct = hash.get("ct");
const ht = hash.get("ht");
// Tokens live only in memory from here on.
history.replaceState(null, "", location.pathname);

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

if (!sid || !ct) {
  const b = $("banner");
  b.hidden = false;
  b.textContent = "Open the link printed by `npm run demo`. It contains the access tokens for this run.";
}

const authHeaders = { Authorization: `Bearer ${ct}` };
const api = (path, opts = {}) => fetch(path, { ...opts, headers: { ...authHeaders, ...(opts.headers ?? {}) } });

// --------------------------------------------------------------------------- status pills

function pill(id, text, state) {
  const p = $(id);
  p.textContent = text;
  p.dataset.state = state;
}

function showCapabilities(c) {
  const cov = (v) => (v === "full" ? "ok" : v === "none" ? "off" : "warn");
  pill("p-human", `Human input: ${c.humanInput.coverage}`, cov(c.humanInput.coverage));
  pill("p-ai", `AI commands: ${c.aiCommands.coverage}`, cov(c.aiCommands.coverage));
  pill("p-observe", `Observing: ${c.observer.observing ? "on" : "off"}`, c.observer.observing ? "ok" : "warn");
  const l = c.stream.latencyMs;
  pill("p-latency", l.p95 === null ? "Latency: –" : `Latency p95: ${l.p95} ms`, l.p95 === null ? "off" : l.p95 <= 100 ? "ok" : "warn");
  $("btn-observe").textContent = c.observer.observing ? "Pause observation" : "Resume observation";
  const notes = [...c.humanInput.notes, ...c.aiCommands.notes];
  const b = $("banner");
  b.hidden = notes.length === 0;
  b.textContent = notes.length ? "Limited coverage: " + notes.join(" ") : "";
}

async function pollCapabilities() {
  try {
    const r = await api(`/api/sessions/${sid}/capabilities`);
    if (r.ok) showCapabilities(await r.json());
  } catch {}
}

// --------------------------------------------------------------------------- timeline

const actors = ["human", "ai", "page", "unknown"];
const symbol = { human: "●", ai: "◆", page: "▲", unknown: "?" };
const certaintyMark = { confirmed: "✓", inferred: "≈", unknown: "?" };
const visible = new Set(actors);
const showSystem = { value: true };
const rows = $("rows");
let lastSeq = 0;
let rendered = [];

const filters = $("filters");
for (const a of actors) {
  const lab = el("label");
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = true;
  cb.addEventListener("change", () => {
    cb.checked ? visible.add(a) : visible.delete(a);
    applyFilter();
  });
  lab.append(cb, document.createTextNode(a));
  filters.append(lab);
}
{
  const lab = el("label");
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = true;
  cb.addEventListener("change", () => {
    showSystem.value = cb.checked;
    applyFilter();
  });
  lab.append(cb, document.createTextNode("system"));
  filters.append(lab);
}

function applyFilter() {
  for (const r of rendered) r.node.hidden = !isShown(r.ev);
}
function isShown(ev) {
  const system = ev.kind === "capability_change" || ev.kind === "stream_gap" || ev.kind === "attribution_update";
  return system ? showSystem.value : visible.has(ev.actor);
}

const q = (s) => `"${s}"`;
function targetText(t) {
  if (!t) return "";
  const base = [t.role ?? t.tag ?? "element"];
  if (t.label) base.push(q(t.label));
  return base.join(" ") + (t.sensitive ? " (sensitive: value never captured)" : "");
}

function summaryText(ev) {
  const d = ev.details ?? {};
  const t = targetText(ev.target);
  switch (ev.kind) {
    case "command":
      return `command ${ev.action} ${d.status}${t ? " on " + t : ""}${d.url ? " " + d.url : ""}${d.error ? " (" + d.error + ")" : ""}`;
    case "navigation":
      return `navigated to ${d.url}${d.navigationKind === "same_document" ? " (same document)" : ""}`;
    case "observation":
      return ev.action === "mutation" ? `page content changed (+${d.added ?? 0} / -${d.removed ?? 0} nodes${t ? ", in " + t : ""})` : `${ev.action}${d.url ? " " + d.url : ""}`;
    case "capability_change":
      return d.summary ?? "coverage changed";
    case "attribution_update":
      return `${d.updates} re-attributed from ${d.previous?.actor}/${d.previous?.certainty} to unknown`;
    case "stream_gap":
      return `${d.lost} event(s) could not be recovered (#${d.fromSequence}–#${d.toSequence})`;
    default: {
      let s = ev.action;
      if (ev.action === "edit") s = "edited";
      if (ev.action === "scroll") s = `scrolled${d.dy ? " " + (d.dy > 0 ? "down " : "up ") + Math.abs(d.dy) + "px" : ""}`;
      if (ev.action === "switch_tab") s = "switched the viewed tab";
      return `${s}${t ? " " + t : ""}${d.keyboardActivation ? " (keyboard)" : ""}`;
    }
  }
}

function evidenceLine(e) {
  switch (e.type) {
    case "human_channel": return `human channel ${e.channelId}: ${e.basis} (${e.match})`;
    case "ai_command": return `AI command ${e.actionId} by ${e.agentId}: ${e.basis} (${e.match})`;
    case "browser_event": return `browser event, isTrusted=${e.trusted}`;
    case "competing_candidates": return "competing sources: " + e.candidates.map((c) => `${c.source}:${c.id} (${c.match})`).join(", ");
    case "no_matching_source": return e.note;
    case "causal_link": return `probably caused by ${e.eventId} (${e.initiatedBy.actor}/${e.initiatedBy.certainty}), ${e.gapMs} ms earlier`;
    case "timing_only": return e.note;
    case "command_registered": return `AI command ${e.actionId} registered before dispatch by ${e.agentId}`;
    case "coverage": return e.note;
    case "downgraded": return `${e.reason}; was ${e.was.actor}/${e.was.certainty}`;
    default: return e.type;
  }
}

function renderEvent(ev) {
  const li = el("li", "row");
  const system = ev.kind === "capability_change" || ev.kind === "stream_gap" || ev.kind === "attribution_update";
  if (system) li.classList.add("system");
  if (ev.kind === "stream_gap") li.classList.add("gap");
  // observedAt is UTC; show it in the viewer's own local time, not the server's.
  const localTime = new Date(ev.observedAt).toLocaleTimeString("en-GB", { hour12: false });
  li.append(el("span", "seq", `#${ev.sequence}`), el("span", "time", localTime));

  const cell = el("span");
  if (!system) {
    const b = el("span", `badge ${ev.actor}${ev.certainty === "inferred" ? " inferred" : ""}${ev.certainty === "unknown" ? " unknown-certainty" : ""}`);
    b.textContent = `${symbol[ev.actor]} ${ev.actor} ${certaintyMark[ev.certainty]}`;
    b.title = `actor: ${ev.actor}, certainty: ${ev.certainty}`;
    cell.append(b);
  } else {
    cell.textContent = ev.kind.replace("_", " ");
  }
  li.append(cell);

  const text = el("span", "text", summaryText(ev));
  if (ev.causedBy) text.append(el("span", "note", `  ← after ${ev.causedBy.replace("event-", "#")}`));
  li.append(text);

  if (ev.evidence?.length || ev.relatedActionIds?.length) {
    const det = el("details", "evidence");
    det.append(el("summary", "", `evidence (${ev.evidence.length})`));
    const ul = el("ul");
    for (const e of ev.evidence) ul.append(el("li", "", evidenceLine(e)));
    if (ev.relatedActionIds.length) ul.append(el("li", "", "related AI actions: " + ev.relatedActionIds.join(", ")));
    ul.append(el("li", "", `tab ${ev.tabId ?? "–"} · frame ${ev.frameId ?? "–"} · document ${ev.documentId ?? "–"}`));
    det.append(ul, el("pre", "", JSON.stringify(ev, null, 2)));
    li.append(det);
  }
  return li;
}

function addEvent(ev) {
  if (ev.kind !== "stream_gap") {
    if (ev.sequence <= lastSeq) return; // already shown (replay overlap)
    lastSeq = ev.sequence;
  } else {
    lastSeq = Math.max(lastSeq, ev.sequence);
  }
  const node = renderEvent(ev);
  node.hidden = !isShown(ev);
  const nearBottom = rows.scrollHeight - rows.scrollTop - rows.clientHeight < 60;
  rows.append(node);
  rendered.push({ ev, node });
  if (rendered.length > 1500) rendered.shift().node.remove();
  if (nearBottom) rows.scrollTop = rows.scrollHeight;
}

function marker(text) {
  const li = el("li", "row marker", text);
  rows.append(li);
}

// --------------------------------------------------------------------------- event stream (with reconnect + replay)

let streamBackoff = 500;
let everConnected = false;
function connectStream() {
  const ws = new WebSocket(`ws://${location.host}/ws/stream`);
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "auth", sessionId: sid, token: ct, since: lastSeq || undefined }));
  });
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "hello") {
      streamBackoff = 500;
      pill("p-stream", "Stream: connected", "ok");
      if (everConnected) marker(`stream reconnected, resumed after #${lastSeq}`);
      everConnected = true;
      showCapabilities(msg.capabilities);
    } else if (msg.type === "event") {
      addEvent(msg.event);
    }
  });
  ws.addEventListener("close", () => {
    pill("p-stream", "Stream: reconnecting", "warn");
    setTimeout(connectStream, streamBackoff);
    streamBackoff = Math.min(streamBackoff * 2, 5000);
  });
}

// --------------------------------------------------------------------------- viewer (the instrumented human channel)

const screen = $("screen");
let frameSize = { width: 1024, height: 640 };
let viewerWs;
function sendViewer(msg) {
  if (viewerWs && viewerWs.readyState === WebSocket.OPEN) viewerWs.send(JSON.stringify(msg));
}
function toPage(ev) {
  const r = screen.getBoundingClientRect();
  return {
    x: Math.round(((ev.clientX - r.left) / r.width) * frameSize.width),
    y: Math.round(((ev.clientY - r.top) / r.height) * frameSize.height),
  };
}

function connectViewer() {
  if (!ht) return;
  const ws = new WebSocket(`ws://${location.host}/ws/viewer`);
  viewerWs = ws;
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", sessionId: sid, token: ht })));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "frame") {
      frameSize = { width: msg.width, height: msg.height };
      screen.src = "data:image/jpeg;base64," + msg.data;
      $("screen-empty").hidden = true;
    } else if (msg.type === "tabs") {
      renderTabs(msg.tabs);
    }
  });
  ws.addEventListener("close", () => setTimeout(connectViewer, 1000));
}

function renderTabs(tabs) {
  const box = $("tabs");
  box.replaceChildren();
  for (const t of tabs) {
    const b = el("button", "tab", t.title || t.url || t.tabId);
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(t.viewed));
    b.title = `${t.tabId}: ${t.url}`;
    b.addEventListener("click", () => sendViewer({ type: "switch_tab", tabId: t.tabId }));
    box.append(b);
  }
  const viewed = tabs.find((t) => t.viewed);
  if (viewed && document.activeElement !== $("addr-input")) $("addr-input").value = viewed.url;
}

screen.addEventListener("click", (ev) => {
  screen.focus();
  sendViewer({ type: "click", ...toPage(ev) });
});
screen.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    sendViewer({ type: "scroll", ...toPage(ev), dx: Math.round(ev.deltaX), dy: Math.round(ev.deltaY) });
  },
  { passive: false },
);
screen.addEventListener("keydown", (ev) => {
  if (ev.key.length > 1 && !["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(ev.key)) return;
  ev.preventDefault();
  sendViewer({ type: "key", key: ev.key, ctrl: ev.ctrlKey, meta: ev.metaKey, alt: ev.altKey, shift: ev.shiftKey });
});
$("addr").addEventListener("submit", (ev) => {
  ev.preventDefault();
  sendViewer({ type: "navigate", url: $("addr-input").value });
});

// --------------------------------------------------------------------------- controls & agent log

$("btn-run").addEventListener("click", async () => {
  await api("/api/demo/run", { method: "POST" });
});
$("btn-stop").addEventListener("click", async () => {
  await api("/api/demo/stop", { method: "POST" });
});
$("btn-observe").addEventListener("click", async () => {
  const caps = await (await api(`/api/sessions/${sid}/capabilities`)).json();
  const r = await api(`/api/sessions/${sid}/observation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: !caps.observer.observing }),
  });
  if (r.ok) showCapabilities(await r.json());
});

let agentSeq = 0;
async function pollAgent() {
  try {
    const r = await api(`/api/demo/agent-log?since=${agentSeq}`);
    if (!r.ok) return;
    const { lines, running } = await r.json();
    const ol = $("agent-log");
    for (const l of lines) {
      agentSeq = Math.max(agentSeq, l.n);
      const li = el("li", l.kind);
      li.append(el("span", "t", l.at), document.createTextNode(l.text));
      ol.append(li);
      ol.scrollTop = ol.scrollHeight;
    }
    $("btn-run").disabled = running;
  } catch {}
}

if (sid && ct) {
  connectStream();
  connectViewer();
  pollCapabilities();
  setInterval(pollCapabilities, 2000);
  setInterval(pollAgent, 600);
}
