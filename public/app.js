// opencode·pixel — phone client for `opencode serve`, styled after Omarchy.
import { api, oc, onUnauthorized } from "./js/api.js";
import { markdown, esc } from "./js/markdown.js";
import { THEMES, applyTheme } from "./js/themes.js";

// ── tiny helpers ──────────────────────────────────────────────────────────────────────
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`ocb.${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`ocb.${k}`, JSON.stringify(v));
    } catch {
      /* private mode etc. */
    }
  },
};

const prefs = {
  theme: "tokyo-night",
  fontScale: 1,
  haptics: true,
  notify: false,
  wakeLock: true,
  enterSends: false,
  showReasoning: true,
  ...store.get("prefs", {}),
};
const savePrefs = () => store.set("prefs", prefs);

const buzz = (ms = 8) => prefs.haptics && navigator.vibrate?.(ms);

export function money(n, cur = "USD") {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  const s = abs.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = n < 0 ? "−" : "";
  return cur === "USD" ? `${sign}$${s}` : `${sign}${s} ${cur}`;
}
export function compact(n) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}
function ago(t) {
  if (!t) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── toasts (mako-style) ───────────────────────────────────────────────────────────────
function toast(text, kind = "info", ms = 3500) {
  const el = h(`<div class="toast ${kind}"><b>${kind === "error" ? "error" : kind === "ok" ? "done" : "opencode"}</b><span></span></div>`);
  el.querySelector("span").textContent = text;
  $("#toasts").append(el);
  el.addEventListener("click", () => el.remove());
  setTimeout(() => el.classList.add("out"), ms);
  setTimeout(() => el.remove(), ms + 400);
}

// ── state ─────────────────────────────────────────────────────────────────────────────
const S = {
  me: null,
  sessions: [],
  status: {}, // sessionID -> SessionStatus
  current: store.get("session", null),
  msgs: new Map(), // messageID -> { info, parts: Map }
  perms: new Map(), // permissionID -> Permission
  providers: [], // /config/providers
  model: store.get("model", null), // { providerID, modelID }
  agents: [],
  agent: store.get("agent", "build"),
  balances: null,
  accounts: null,
  attachments: [],
  ws: 0,
};

const WORKSPACES = [
  { id: "chat", n: 1, label: "chat" },
  { id: "sessions", n: 2, label: "sessions" },
  { id: "balance", n: 3, label: "balance" },
  { id: "account", n: 4, label: "account" },
  { id: "settings", n: 5, label: "settings" },
];

// ── boot ──────────────────────────────────────────────────────────────────────────────
applyTheme(prefs.theme);
document.documentElement.style.setProperty("--scale", prefs.fontScale);
onUnauthorized(() => showLogin());

async function boot() {
  try {
    S.me = await api("/api/me");
  } catch (e) {
    if (e.status === 401) return showLogin();
    toast(`Bridge unreachable: ${e.message}`, "error", 8000);
    return showLogin();
  }
  startDesktop();
}

function showLogin() {
  stopEvents();
  $("#desktop").hidden = true;
  $("#login").hidden = false;
  $("#login-host").textContent = location.host;
  const u = $('#login-form [name="username"]');
  if (!u.value) u.value = store.get("lastUser", "");
  (u.value ? $('#login-form [name="password"]') : u).focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = $("button[type=submit]", e.target);
  btn.disabled = true;
  $("#login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { username: f.get("username"), password: f.get("password") } });
    store.set("lastUser", f.get("username"));
    e.target.reset();
    $("#login").hidden = true;
    buzz(15);
    boot();
  } catch (err) {
    $("#login-error").textContent = err.message;
    buzz([30, 40, 30]);
  } finally {
    btn.disabled = false;
  }
});

let started = false;
function startDesktop() {
  $("#login").hidden = true;
  $("#desktop").hidden = false;
  if (!started) {
    started = true;
    buildWaybar();
    initSwipe();
    initComposer();
    initWalker();
    initSheet();
    initKeys();
  }
  const want = store.get("ws", 0);
  goWs(new URLSearchParams(location.search).has("ws") ? Number(new URLSearchParams(location.search).get("ws")) : want, false);
  handleShare();
  startEvents();
  loadAll();
}

async function loadAll() {
  await Promise.allSettled([loadModels(), loadSessions()]);
  if (S.current && S.sessions.some((s) => s.id === S.current)) openSession(S.current, false);
  else renderChat();
  refreshBalances();
  renderAccount();
  renderSettings();
}

// ── waybar ────────────────────────────────────────────────────────────────────────────
function buildWaybar() {
  const nav = $("#ws-nav");
  for (const [i, w] of WORKSPACES.entries()) {
    const b = h(`<button class="ws" aria-label="${w.label}" title="${w.label}">${w.n}</button>`);
    b.addEventListener("click", () => goWs(i));
    nav.append(b);
  }
  $("#super").addEventListener("click", openWalker);
  $("#wb-spend").addEventListener("click", () => goWs(2));
  $("#clock").addEventListener("click", openWalker);
  const tick = () => {
    const d = new Date();
    $("#clock").textContent = d.toLocaleDateString(undefined, { weekday: "short" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  };
  tick();
  setInterval(tick, 15_000);
  navigator.getBattery?.().then((b) => {
    const upd = () => {
      const el = $("#wb-batt");
      el.hidden = false;
      const pct = Math.round(b.level * 100);
      el.textContent = `${b.charging ? "⚡" : ""}${pct}%`;
      el.classList.toggle("low", pct <= 20 && !b.charging);
    };
    upd();
    b.addEventListener("levelchange", upd);
    b.addEventListener("chargingchange", upd);
  });
}

function setNet(state) {
  const el = $("#wb-net");
  el.dataset.state = state;
  el.title = { up: "connected to opencode", down: "disconnected — retrying", wait: "connecting…" }[state];
}

// ── workspaces & swipe ────────────────────────────────────────────────────────────────
function goWs(i, animate = true) {
  i = Math.max(0, Math.min(WORKSPACES.length - 1, Number.isFinite(i) ? i : 0));
  const changed = i !== S.ws;
  S.ws = i;
  store.set("ws", i);
  const track = $("#track");
  track.classList.toggle("anim", animate);
  track.style.transform = `translateX(${-i * 100}%)`;
  $$("#ws-nav .ws").forEach((b, j) => b.classList.toggle("active", i === j));
  if (i > 0) S.side = i;
  track.dataset.side = WORKSPACES[S.side || 1].id;
  const wide = matchMedia("(min-width: 760px)").matches;
  $$(".workspace").forEach((w, j) => w.toggleAttribute("inert", wide ? j !== 0 && j !== (S.side || 1) : i !== j));
  if (changed) buzz(5);
  const id = WORKSPACES[i].id;
  if (id === "balance" && changed) refreshBalances();
  if (id === "account" && changed) renderAccount();
  if (id === "chat") requestAnimationFrame(() => scrollChat(false));
}

matchMedia("(min-width: 760px)").addEventListener("change", () => goWs(S.ws, false));

function initSwipe() {
  const vp = $("#viewport");
  const track = $("#track");
  let x0 = 0, y0 = 0, dx = 0, active = false, locked = null;
  vp.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1 || matchMedia("(min-width: 760px)").matches || e.target.closest("pre, .table, .hscroll, textarea, input, .sheet")) return (active = false);
      active = true;
      locked = null;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      dx = 0;
    },
    { passive: true },
  );
  vp.addEventListener(
    "touchmove",
    (e) => {
      if (!active) return;
      dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (locked === null && Math.hypot(dx, dy) > 12) locked = Math.abs(dx) > Math.abs(dy) * 1.6 ? "x" : "y";
      if (locked !== "x") return;
      const edge = (S.ws === 0 && dx > 0) || (S.ws === WORKSPACES.length - 1 && dx < 0);
      track.classList.remove("anim");
      track.style.transform = `translateX(calc(${-S.ws * 100}% + ${edge ? dx / 4 : dx}px))`;
    },
    { passive: true },
  );
  vp.addEventListener("touchend", () => {
    if (!active) return;
    active = false;
    if (locked !== "x") return;
    const w = vp.clientWidth;
    if (dx < -w * 0.22) goWs(S.ws + 1);
    else if (dx > w * 0.22) goWs(S.ws - 1);
    else goWs(S.ws);
  });
}

function initKeys() {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openWalker();
    } else if (e.altKey && /^[1-5]$/.test(e.key)) {
      e.preventDefault();
      goWs(Number(e.key) - 1);
    } else if (e.key === "Escape") {
      closeWalker();
      closeSheet();
    }
  });
}

// ── live events from opencode (SSE) ───────────────────────────────────────────────────
let es = null;
let retry = 1000;
function startEvents() {
  stopEvents();
  setNet("wait");
  es = new EventSource("/api/oc/event");
  es.onopen = () => {
    retry = 1000;
    setNet("up");
  };
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch (err) {
      console.warn("bad event", err);
    }
  };
  es.onerror = () => {
    setNet("down");
    es?.close();
    es = null;
    setTimeout(async () => {
      if (es || $("#desktop").hidden) return;
      try {
        await api("/api/me"); // also detects an expired login
        startEvents();
        loadSessions();
        if (S.current) loadMessages(S.current);
      } catch {
        retry = Math.min(retry * 2, 30_000);
        es = null;
        setTimeout(() => !es && !$("#desktop").hidden && startEvents(), retry);
      }
    }, retry);
  };
}
function stopEvents() {
  es?.close();
  es = null;
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !$("#desktop").hidden && !es) startEvents();
});

function onEvent({ type, properties: p }) {
  switch (type) {
    case "server.connected":
      setNet("up");
      break;
    case "message.updated": {
      const info = p.info;
      if (info.sessionID !== S.current) break;
      const m = S.msgs.get(info.id) || { info, parts: new Map() };
      m.info = info;
      S.msgs.set(info.id, m);
      queueRender(info.id);
      if (info.role === "assistant" && info.time?.completed) refreshBalancesSoon();
      break;
    }
    case "message.part.updated": {
      const part = p.part;
      if (part.sessionID !== S.current) break;
      let m = S.msgs.get(part.messageID);
      if (!m) S.msgs.set(part.messageID, (m = { info: { id: part.messageID, sessionID: part.sessionID, role: "assistant", time: { created: Date.now() } }, parts: new Map() }));
      m.parts.set(part.id, part);
      queueRender(part.messageID);
      break;
    }
    case "message.part.removed": {
      const m = S.msgs.get(p.messageID);
      if (m) {
        m.parts.delete(p.partID);
        queueRender(p.messageID);
      }
      break;
    }
    case "message.removed":
      if (S.msgs.delete(p.messageID)) $(`#m-${CSS.escape(p.messageID)}`)?.remove();
      break;
    case "session.status":
      S.status[p.sessionID] = p.status;
      updateBusy();
      renderSessionList();
      break;
    case "session.idle":
      S.status[p.sessionID] = { type: "idle" };
      updateBusy();
      renderSessionList();
      notifyDone(p.sessionID);
      break;
    case "session.created":
    case "session.updated": {
      const i = S.sessions.findIndex((s) => s.id === p.info.id);
      if (i >= 0) S.sessions[i] = p.info;
      else S.sessions.unshift(p.info);
      S.sessions.sort((a, b) => b.time.updated - a.time.updated);
      renderSessionList();
      if (p.info.id === S.current) renderChatHead();
      break;
    }
    case "session.deleted":
      S.sessions = S.sessions.filter((s) => s.id !== p.info.id);
      renderSessionList();
      if (p.info.id === S.current) newChat();
      break;
    case "session.error":
      if (!p.sessionID || p.sessionID === S.current) toast(p.error?.data?.message || p.error?.name || "Session error", "error", 7000);
      break;
    case "permission.updated":
      S.perms.set(p.id, p);
      renderPerms();
      if (p.sessionID !== S.current) toast(`Permission needed: ${p.title}`, "info", 6000);
      buzz([20, 60, 20]);
      break;
    case "permission.replied":
      S.perms.delete(p.permissionID);
      renderPerms();
      break;
    case "todo.updated":
      break;
  }
}

// ── models & agents ───────────────────────────────────────────────────────────────────
async function loadModels() {
  const [prov, cfg, agents] = await Promise.all([oc("/config/providers"), oc("/config").catch(() => ({})), oc("/agent").catch(() => [])]);
  S.providers = prov.providers || [];
  S.agents = (agents || []).filter((a) => a.mode !== "subagent" && !a.hidden);
  if (!S.agents.length) S.agents = [{ name: "build" }, { name: "plan" }];
  if (!S.agents.some((a) => a.name === S.agent)) S.agent = S.agents[0].name;
  const valid = (m) => m && S.providers.some((p) => p.id === m.providerID && p.models?.[m.modelID]);
  if (!valid(S.model)) {
    let m = null;
    if (cfg?.model?.includes("/")) {
      const [providerID, ...rest] = cfg.model.split("/");
      m = { providerID, modelID: rest.join("/") };
    }
    if (!valid(m)) {
      const p = S.providers.find((x) => x.id === "opencode") || S.providers.find((x) => prov.default?.[x.id]) || S.providers[0];
      m = p ? { providerID: p.id, modelID: prov.default?.[p.id] || Object.keys(p.models)[0] } : null;
    }
    S.model = m;
  }
  renderChatHead();
}

function modelInfo(m = S.model) {
  if (!m) return null;
  const p = S.providers.find((x) => x.id === m.providerID);
  return p?.models?.[m.modelID] ? { provider: p, model: p.models[m.modelID] } : null;
}

function setModel(m) {
  S.model = m;
  store.set("model", m);
  renderChatHead();
}

function openModelPicker() {
  const byKey = Object.fromEntries((S.balances?.models || []).map((m) => [m.key, m]));
  const body = h(`<div class="picker"><input type="search" placeholder="search models…" class="picker-q" aria-label="Search models" /><div class="picker-list"></div></div>`);
  const list = $(".picker-list", body);
  const draw = (q = "") => {
    q = q.toLowerCase();
    list.innerHTML = "";
    for (const p of S.providers) {
      const models = Object.values(p.models || {}).filter((m) => !q || `${p.name} ${m.name} ${m.id}`.toLowerCase().includes(q));
      if (!models.length) continue;
      list.append(h(`<div class="group-h">${esc(p.name)}</div>`));
      for (const m of models) {
        const b = byKey[`${p.id}/${m.id}`];
        const sel = S.model?.providerID === p.id && S.model?.modelID === m.id;
        const free = !m.cost?.input && !m.cost?.output;
        const left = free ? `<span class="ok">free</span>` : b?.spendable !== null && b?.spendable !== undefined ? `<span class="${b.spendable <= 0 ? "bad" : "ok"}">${money(b.spendable, b.currency)}</span>` : `<span class="dim">—</span>`;
        const row = h(`<button class="pick ${sel ? "sel" : ""}">
          <span class="pick-main"><b>${esc(m.name)}</b><small class="dim">${esc(m.id)} · ${compact(m.limit?.context || 0)} ctx${m.capabilities?.reasoning ? " · think" : ""}${m.capabilities?.attachment ? " · img" : ""}</small></span>
          <span class="pick-side">${left}<small class="dim">${free ? "" : `$${m.cost.input}/$${m.cost.output}`}</small></span></button>`);
        row.addEventListener("click", () => {
          setModel({ providerID: p.id, modelID: m.id });
          buzz();
          closeSheet();
        });
        list.append(row);
      }
    }
    if (!list.children.length) list.append(h(`<p class="dim pad">No models. Connect a provider in workspace 4.</p>`));
  };
  draw();
  $(".picker-q", body).addEventListener("input", (e) => draw(e.target.value));
  openSheet("model · balance left · $/1M in/out", body);
}

// ── sessions ──────────────────────────────────────────────────────────────────────────
async function loadSessions() {
  const [list, status] = await Promise.all([oc("/session"), oc("/session/status").catch(() => ({}))]);
  S.sessions = (list || []).filter((s) => !s.parentID).sort((a, b) => b.time.updated - a.time.updated);
  S.status = status || {};
  renderSessionList();
  updateBusy();
}

function renderSessionList() {
  const ul = $("#session-list");
  const q = $("#session-filter").value.toLowerCase();
  ul.innerHTML = "";
  const rows = S.sessions.filter((s) => !q || s.title.toLowerCase().includes(q));
  for (const s of rows) {
    const busy = S.status[s.id]?.type === "busy" || S.status[s.id]?.type === "retry";
    const li = h(`<li class="row ${s.id === S.current ? "sel" : ""}">
      <button class="row-main"><span class="row-title">${busy ? '<span class="spin"></span>' : ""}${esc(s.title)}</span>
      <small class="dim">${ago(s.time.updated)}${s.summary?.files ? ` · ${s.summary.files} files <span class="ok">+${s.summary.additions}</span> <span class="bad">−${s.summary.deletions}</span>` : ""}</small></button>
      <button class="icon-btn" aria-label="More">⋯</button></li>`);
    li.querySelector(".row-main").addEventListener("click", () => {
      openSession(s.id);
      goWs(0);
    });
    li.querySelector(".icon-btn").addEventListener("click", () => sessionMenu(s));
    ul.append(li);
  }
  if (!rows.length) ul.append(h(`<li class="empty dim">${q ? "no match" : "no sessions yet — start one in workspace 1"}</li>`));
}
$("#session-filter").addEventListener("input", renderSessionList);
$("#new-session").addEventListener("click", () => {
  newChat();
  goWs(0);
});

function sessionMenu(s) {
  const body = h(`<div class="menu">
    <label class="field"><span>title</span><input value="${esc(s.title)}" maxlength="120" /></label>
    <button class="btn" data-a="rename">rename</button>
    ${s.share?.url ? `<a class="btn" href="${esc(s.share.url)}" target="_blank" rel="noopener">open share link</a>` : `<button class="btn" data-a="share">create share link</button>`}
    <button class="btn danger" data-a="delete">delete session</button></div>`);
  body.addEventListener("click", async (e) => {
    const a = e.target.dataset.a;
    if (!a) return;
    try {
      if (a === "rename") await oc(`/session/${s.id}`, { method: "PATCH", body: { title: $("input", body).value.trim() || s.title } });
      if (a === "share") {
        const r = await oc(`/session/${s.id}/share`, { method: "POST" });
        if (r?.share?.url) {
          await navigator.clipboard?.writeText(r.share.url).catch(() => {});
          toast("Share link copied", "ok");
        }
      }
      if (a === "delete") {
        if (!confirm(`Delete “${s.title}”?`)) return;
        await oc(`/session/${s.id}`, { method: "DELETE" });
        S.sessions = S.sessions.filter((x) => x.id !== s.id);
        if (S.current === s.id) newChat();
      }
      closeSheet();
      loadSessions();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  openSheet("session", body);
}

function newChat() {
  S.current = null;
  store.set("session", null);
  S.msgs.clear();
  renderChat();
  renderSessionList();
  $("#prompt").focus();
}

async function openSession(id, focus = true) {
  S.current = id;
  store.set("session", id);
  S.msgs.clear();
  renderChat();
  renderSessionList();
  await loadMessages(id);
  if (focus) buzz();
}

async function loadMessages(id) {
  try {
    const list = await oc(`/session/${id}/message`);
    if (S.current !== id) return;
    S.msgs.clear();
    for (const { info, parts } of list || []) S.msgs.set(info.id, { info, parts: new Map(parts.map((p) => [p.id, p])) });
    // Follow the model the session last used.
    const lastUser = [...S.msgs.values()].reverse().find((m) => m.info.role === "user");
    if (lastUser?.info.model && modelInfo(lastUser.info.model)) setModel(lastUser.info.model);
    renderChat();
    scrollChat(false);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── chat rendering ────────────────────────────────────────────────────────────────────
function renderChatHead() {
  const s = S.sessions.find((x) => x.id === S.current);
  $("#chat-title").textContent = s ? s.title : "new session";
  const mi = modelInfo();
  $("#model-chip").innerHTML = mi ? `${esc(mi.model.name)}<small>${esc(mi.provider.name)}</small>` : "pick model";
  $("#agent-chip").textContent = S.agent;
  $("#agent-chip").dataset.agent = S.agent;
}
$("#chat-title").addEventListener("click", () => goWs(1));
$("#model-chip").addEventListener("click", openModelPicker);
$("#agent-chip").addEventListener("click", () => {
  const i = S.agents.findIndex((a) => a.name === S.agent);
  S.agent = S.agents[(i + 1) % S.agents.length].name;
  store.set("agent", S.agent);
  buzz();
  renderChatHead();
  toast(`agent: ${S.agent}`);
});

function sortedMsgs() {
  return [...S.msgs.values()].sort((a, b) => (a.info.time?.created || 0) - (b.info.time?.created || 0) || (a.info.id < b.info.id ? -1 : 1));
}

function renderChat() {
  renderChatHead();
  const log = $("#chat-log");
  log.innerHTML = "";
  const msgs = sortedMsgs();
  if (!msgs.length) {
    const mi = modelInfo();
    log.append(
      h(`<div class="motd"><pre class="dim">${esc(`$ opencode --model ${S.model ? `${S.model.providerID}/${S.model.modelID}` : "?"} --agent ${S.agent}`)}</pre>
        <p>New session. Ask anything about your project${S.me?.opencode?.directory ? ` in <code>${esc(S.me.opencode.directory)}</code>` : ""}.</p>
        <p class="dim">swipe ← → between workspaces · tap the model chip to see balance per model${mi ? "" : " · no model yet: connect a provider in workspace 4"}</p></div>`),
    );
  }
  for (const m of msgs) log.append(renderMsg(m));
  renderPerms();
  updateBusy();
}

const pending = new Set();
let raf = 0;
function queueRender(id) {
  pending.add(id);
  if (!raf) raf = requestAnimationFrame(flushRender);
}
function flushRender() {
  raf = 0;
  const log = $("#chat-log");
  const stick = nearBottom();
  $(".motd", log)?.remove();
  for (const id of pending) {
    const m = S.msgs.get(id);
    if (!m) continue;
    const el = renderMsg(m);
    const old = $(`#m-${CSS.escape(id)}`, log);
    if (old) old.replaceWith(el);
    else {
      // insert in time order (almost always: append)
      const next = [...log.children].find((c) => Number(c.dataset.t) > (m.info.time?.created || 0));
      log.insertBefore(el, next || null);
    }
  }
  pending.clear();
  if (stick) scrollChat(false);
  else $("#jump").hidden = false;
}

function nearBottom() {
  const log = $("#chat-log");
  return log.scrollHeight - log.scrollTop - log.clientHeight < 120;
}
function scrollChat(smooth = true) {
  const log = $("#chat-log");
  log.scrollTo({ top: log.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  $("#jump").hidden = true;
}
$("#jump").addEventListener("click", () => scrollChat());
$("#chat-log").addEventListener("scroll", () => nearBottom() && ($("#jump").hidden = true), { passive: true });

// copy buttons inside code blocks
$("#chat-log").addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const code = b.closest(".code")?.querySelector("code")?.textContent ?? "";
  navigator.clipboard?.writeText(code).then(() => {
    b.textContent = "copied";
    buzz();
    setTimeout(() => (b.textContent = "copy"), 1200);
  });
});

function toolSummary(part) {
  const i = part.state?.input || {};
  const rel = (p) => String(p || "").replace(S.me?.opencode?.directory ? S.me.opencode.directory + "/" : "\u0000", "");
  switch (part.tool) {
    case "bash":
      return i.command;
    case "read":
    case "write":
    case "edit":
      return rel(i.filePath);
    case "glob":
    case "grep":
      return `${i.pattern || ""}${i.path ? ` in ${rel(i.path)}` : ""}`;
    case "webfetch":
      return i.url;
    case "task":
      return i.description;
    case "todowrite":
      return `${(i.todos || []).length} todos`;
    default:
      return part.state?.title || JSON.stringify(i).slice(0, 80);
  }
}

function renderPart(part) {
  switch (part.type) {
    case "text":
      if (part.synthetic || part.ignored || !part.text) return "";
      return `<div class="md">${markdown(part.text)}</div>`;
    case "reasoning":
      if (!prefs.showReasoning || !part.text?.trim()) return "";
      return `<details class="reasoning"${part.time?.end ? "" : " open"}><summary>thinking${part.time?.end ? ` · ${((part.time.end - part.time.start) / 1000).toFixed(1)}s` : "…"}</summary><div class="md">${markdown(part.text)}</div></details>`;
    case "tool": {
      const st = part.state?.status || "pending";
      const icon = { pending: "○", running: '<span class="spin"></span>', completed: "●", error: "✕" }[st];
      const out = st === "completed" ? part.state.output : st === "error" ? part.state.error : "";
      const todos = part.tool === "todowrite" && Array.isArray(part.state?.input?.todos) ? `<ul class="todos">${part.state.input.todos.map((t) => `<li class="${esc(t.status)}">${t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} ${esc(t.content)}</li>`).join("")}</ul>` : "";
      const head = `<span class="t-icon">${icon}</span><span class="t-name">${esc(part.tool)}</span><span class="t-arg">${esc(toolSummary(part) || "")}</span>`;
      if (!out && !todos) return `<div class="tool ${st}">${head}</div>`;
      return `<details class="tool ${st}"><summary>${head}</summary>${todos}${out ? `<pre class="t-out">${esc(String(out).slice(0, 6000))}${String(out).length > 6000 ? "\n…" : ""}</pre>` : ""}</details>`;
    }
    case "file":
      return part.mime?.startsWith("image/") && part.url?.startsWith("data:") ? `<img class="att" src="${esc(part.url)}" alt="${esc(part.filename || "image")}">` : `<div class="filechip">📎 ${esc(part.filename || part.url)}</div>`;
    case "patch":
      return `<div class="note">✎ changed ${part.files?.length || 0} file(s)</div>`;
    case "agent":
      return `<div class="note">@${esc(part.name)}</div>`;
    case "subtask":
      return `<div class="note">↳ subtask (${esc(part.agent)}): ${esc(part.description)}</div>`;
    case "retry":
      return `<div class="note warn">retrying (attempt ${part.attempt}) — ${esc(part.error?.data?.message || "")}</div>`;
    case "compaction":
      return `<div class="note">context compacted</div>`;
    default:
      return "";
  }
}

function renderMsg(m) {
  const { info } = m;
  const parts = [...m.parts.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const html = parts.map(renderPart).join("");
  if (info.role === "user") {
    return h(`<div class="msg user" id="m-${esc(info.id)}" data-t="${info.time?.created || 0}"><span class="ps1">❯</span><div class="body">${html}</div></div>`);
  }
  const done = info.time?.completed;
  const t = info.tokens;
  const foot = done
    ? `<div class="foot dim">${esc(info.modelID || "")} · ${compact((t?.input || 0) + (t?.cache?.read || 0))} in · ${compact((t?.output || 0) + (t?.reasoning || 0))} out · ${money(info.cost || 0)} · ${((done - info.time.created) / 1000).toFixed(1)}s</div>`
    : "";
  const err = info.error ? `<div class="note bad">✕ ${esc(info.error.data?.message || info.error.name)}</div>` : "";
  const working = !done && !info.error && !html ? `<div class="dim"><span class="spin"></span> working…</div>` : "";
  return h(`<div class="msg asst" id="m-${esc(info.id)}" data-t="${info.time?.created || 0}">${html}${working}${err}${foot}</div>`);
}

function renderPerms() {
  const box = $("#perms");
  box.innerHTML = "";
  for (const p of S.perms.values()) {
    if (p.sessionID !== S.current) continue;
    const pat = Array.isArray(p.pattern) ? p.pattern.join(" ") : p.pattern || "";
    const el = h(`<div class="perm"><div><b>permission · ${esc(p.type)}</b><p>${esc(p.title)}</p>${pat ? `<code>${esc(pat)}</code>` : ""}</div>
      <div class="perm-btns"><button class="btn primary" data-r="once">allow</button><button class="btn" data-r="always">always</button><button class="btn danger" data-r="reject">reject</button></div></div>`);
    el.addEventListener("click", async (e) => {
      const r = e.target.dataset.r;
      if (!r) return;
      try {
        await oc(`/session/${p.sessionID}/permissions/${p.id}`, { method: "POST", body: { response: r } });
        S.perms.delete(p.id);
        renderPerms();
        buzz();
      } catch (err) {
        toast(err.message, "error");
      }
    });
    box.append(el);
  }
}

let wakeLock = null;
function updateBusy() {
  const st = S.status[S.current]?.type;
  const busy = st === "busy" || st === "retry";
  $("#chat-busy").hidden = !busy;
  $("#chat-label").textContent = st === "retry" ? `chat · retry ${S.status[S.current].attempt}` : busy ? "chat · working" : "chat";
  // opencode reports provider trouble (rate limits, out of credit…) as a retry status.
  const r = $("#retry");
  const rs = S.status[S.current];
  r.hidden = rs?.type !== "retry";
  if (rs?.type === "retry") {
    const a = rs.action;
    const link = a?.link && /^https?:\/\//.test(a.link) ? ` <a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.label || "open")} ↗</a>` : "";
    r.innerHTML = `<b>${esc(a?.title || `retrying (attempt ${rs.attempt})`)}</b><span>${esc(a?.message || rs.message || "")}${link}</span>${rs.next ? `<small class="dim">next try ${new Date(rs.next).toLocaleTimeString()} · tap ■ to stop</small>` : ""}`;
  }
  $("#stop-btn").hidden = !busy;
  $("#send-btn").hidden = busy && !$("#prompt").value.trim();
  if (busy && prefs.wakeLock && !wakeLock && navigator.wakeLock) {
    navigator.wakeLock.request("screen").then((l) => {
      wakeLock = l;
      l.addEventListener("release", () => (wakeLock = null));
    }).catch(() => {});
  }
  if (!busy && wakeLock) wakeLock.release().catch(() => {});
}

async function notifyDone(sessionID) {
  if (!prefs.notify || !document.hidden || Notification?.permission !== "granted") return;
  const s = S.sessions.find((x) => x.id === sessionID);
  const reg = await navigator.serviceWorker?.getRegistration();
  const opts = { body: `${s?.title || "session"} is done`, tag: sessionID, icon: "/icons/icon-192.png", badge: "/icons/badge.png", data: { sessionID } };
  if (reg) reg.showNotification("opencode", opts);
  else new Notification("opencode", opts);
}

// ── composer ──────────────────────────────────────────────────────────────────────────
function initComposer() {
  const ta = $("#prompt");
  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.35) + "px";
    updateBusy();
  };
  ta.addEventListener("input", () => {
    grow();
    store.set("draft", ta.value);
  });
  ta.value = store.get("draft", "");
  grow();
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && (prefs.enterSends || e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  $("#stop-btn").addEventListener("click", async () => {
    if (!S.current) return;
    buzz(20);
    await oc(`/session/${S.current}/abort`, { method: "POST" }).catch((err) => toast(err.message, "error"));
  });
  $("#attach-btn").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", async (e) => {
    for (const f of e.target.files) await addAttachment(f);
    e.target.value = "";
  });

  // Voice dictation (Chrome on Android ships the Web Speech API).
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const mic = $("#mic-btn");
    mic.hidden = false;
    let rec = null;
    mic.addEventListener("click", () => {
      if (rec) return rec.stop();
      rec = new SR();
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      const base = ta.value ? ta.value.replace(/\s*$/, " ") : "";
      rec.onresult = (ev) => {
        ta.value = base + [...ev.results].map((r) => r[0].transcript).join("");
        grow();
      };
      rec.onend = () => {
        rec = null;
        mic.classList.remove("rec");
        store.set("draft", ta.value);
      };
      rec.onerror = (ev) => ev.error !== "no-speech" && toast(`mic: ${ev.error}`, "error");
      mic.classList.add("rec");
      buzz(15);
      rec.start();
    });
  }
}

// Downscale big photos (Pixel camera shots are ~12 MP) before sending them to a model.
async function addAttachment(file) {
  try {
    let url, mime = file.type || "application/octet-stream";
    if (mime.startsWith("image/") && mime !== "image/gif") {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      url = c.toDataURL("image/jpeg", 0.85);
      mime = "image/jpeg";
    } else {
      if (file.size > 10e6) return toast("File too large (10 MB max)", "error");
      url = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
    }
    S.attachments.push({ type: "file", mime, url, filename: file.name });
    renderAttachments();
  } catch (e) {
    toast(`Couldn't attach ${file.name}: ${e.message}`, "error");
  }
}
function renderAttachments() {
  const box = $("#attachments");
  box.innerHTML = "";
  S.attachments.forEach((a, i) => {
    const el = h(`<button type="button" class="att-chip" aria-label="Remove ${esc(a.filename)}">${a.mime.startsWith("image/") ? `<img src="${esc(a.url)}" alt="">` : "📎"}<span>${esc(a.filename)}</span>✕</button>`);
    el.addEventListener("click", () => {
      S.attachments.splice(i, 1);
      renderAttachments();
    });
    box.append(el);
  });
}

async function send() {
  const ta = $("#prompt");
  const text = ta.value.trim();
  if (!text && !S.attachments.length) return;
  if (!S.model) {
    toast("Pick a model first", "error");
    return openModelPicker();
  }
  // Slash commands map onto opencode's command endpoint (e.g. /init, /review, custom ones).
  const cmd = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  buzz(12);
  const files = S.attachments.splice(0);
  ta.value = "";
  store.set("draft", "");
  ta.dispatchEvent(new Event("input"));
  renderAttachments();
  try {
    if (!S.current) {
      const s = await oc("/session", { method: "POST", body: {} });
      S.sessions.unshift(s);
      S.current = s.id;
      store.set("session", s.id);
      S.msgs.clear();
      renderChat();
    }
    S.status[S.current] = { type: "busy" };
    updateBusy();
    const model = `${S.model.providerID}/${S.model.modelID}`;
    if (cmd && !files.length) {
      oc(`/session/${S.current}/command`, { method: "POST", body: { command: cmd[1], arguments: cmd[2], agent: S.agent, model } }).catch((e) => toast(e.message, "error"));
    } else {
      await oc(`/session/${S.current}/prompt_async`, { method: "POST", body: { model: S.model, agent: S.agent, parts: [...(text ? [{ type: "text", text }] : []), ...files] } });
    }
    scrollChat();
  } catch (e) {
    toast(e.message, "error", 6000);
    ta.value = text;
    S.status[S.current] = { type: "idle" };
    updateBusy();
  }
}

// Android share sheet → "opencode·pixel" (manifest share_target).
function handleShare() {
  const q = new URLSearchParams(location.search);
  const shared = [q.get("title"), q.get("text"), q.get("url")].filter(Boolean).join("\n");
  if (!shared) return;
  history.replaceState(null, "", "/");
  newChat();
  $("#prompt").value = shared;
  $("#prompt").dispatchEvent(new Event("input"));
  goWs(0);
}

// ── balance ───────────────────────────────────────────────────────────────────────────
let balTimer = 0;
function refreshBalancesSoon() {
  clearTimeout(balTimer);
  balTimer = setTimeout(refreshBalances, 1500);
}
async function refreshBalances(force = false) {
  try {
    S.balances = await api(`/api/balances${force ? "?force=1" : ""}`);
    $("#wb-spend").textContent = money(S.balances.total.day);
    renderBalance();
  } catch (e) {
    $("#balance").innerHTML = `<p class="bad pad">${esc(e.message)}</p>`;
  }
}

const balUi = { q: "", used: store.get("balUsed", false), open: new Set() };

function bar(used, cap) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  return `<span class="bar ${pct > 90 ? "hot" : pct > 70 ? "warm" : ""}"><i style="width:${pct.toFixed(1)}%"></i></span>`;
}

function renderBalance() {
  const B = S.balances;
  const root = $("#balance");
  if (!B) return;
  const prov = B.providers
    .map((p) => {
      const b = p.balance;
      const src = { live: "live", manual: "tracked", subscription: "plan", none: "no balance api" }[b.source];
      const amount = b.source === "subscription" ? `<span class="big">plan</span>` : Number.isFinite(b.amount) ? `<span class="big ${b.amount <= 0 ? "bad" : b.amount < 5 ? "warn" : "ok"}">${money(b.amount, b.currency)}</span>` : `<span class="big dim">${b.error ? "error" : "—"}</span>`;
      const canSet = b.source !== "live";
      return `<div class="card prov" data-p="${esc(p.id)}">
        <div class="card-h"><b>${esc(p.name)}</b><span class="badge">${src}</span></div>
        ${amount}
        <small class="dim">${esc(b.error ? `${b.error}` : b.detail || (b.source === "none" ? "spend is tracked below; set your balance to track what's left" : ""))}</small>
        <small class="dim">spent: ${money(p.spend?.windows.day || 0)} 24h · ${money(p.spend?.windows.month || 0)} 30d · ${money(p.spend?.cost || 0)} all</small>
        ${canSet ? `<form class="inline-form" data-set-balance="${esc(p.id)}"><input inputmode="decimal" placeholder="${b.source === "manual" ? "update balance" : "current balance"}" aria-label="Balance for ${esc(p.name)}" /><button class="btn">set</button>${b.source === "manual" ? `<button class="btn ghost" type="button" data-clear-balance="${esc(p.id)}">clear</button>` : ""}</form>` : ""}
        ${p.id === "opencode" ? `<a class="link" href="https://opencode.ai/console" target="_blank" rel="noopener">top up Zen credits ↗</a>` : ""}
      </div>`;
    })
    .join("");

  const q = balUi.q.toLowerCase();
  const models = B.models.filter((m) => (!balUi.used || m.spend) && (!q || `${m.name} ${m.modelID} ${m.providerName}`.toLowerCase().includes(q)));
  const rows = models
    .slice(0, 300)
    .map((m) => {
      const open = balUi.open.has(m.key);
      const left = m.free ? `<b class="ok">free</b>` : m.spendable !== null ? `<b class="${m.spendable <= 0 ? "bad" : m.spendable < 2 ? "warn" : "ok"}">${money(m.spendable, m.currency)}</b>` : `<b class="dim">—</b>`;
      const tok = m.tokensLeft?.output ? `≈ ${compact(m.tokensLeft.output)} out / ${compact(m.tokensLeft.input)} in tokens left` : m.free ? "no cost" : "set a balance to estimate tokens left";
      const lim = m.limits
        ? `<div class="limits">${["5h", "week", "month"].map((w) => `<div class="lim"><span>${w}</span>${bar(m.limits[w].used, m.limits[w].cap)}<small>${money(m.limits[w].used)} / ${money(m.limits[w].cap)}</small></div>`).join("")}</div>`
        : "";
      const detail = open
        ? `<div class="m-detail">
          <div class="kv"><span>price /1M</span><span>in $${m.cost.input} · out $${m.cost.output}${m.cost.cacheRead ? ` · cache $${m.cost.cacheRead}` : ""}</span></div>
          <div class="kv"><span>context</span><span>${compact(m.context)}</span></div>
          <div class="kv"><span>spent</span><span>${money(m.spend?.windows["5h"] || 0)} 5h · ${money(m.spend?.windows.day || 0)} 24h · ${money(m.spend?.windows.week || 0)} 7d · ${money(m.spend?.windows.month || 0)} 30d</span></div>
          <div class="kv"><span>all time</span><span>${money(m.spend?.cost || 0)} · ${m.spend?.requests || 0} replies · ${compact(m.spend?.input || 0)} in · ${compact(m.spend?.output || 0)} out · ${compact(m.spend?.cacheRead || 0)} cached</span></div>
          <form class="inline-form" data-set-limit="${esc(m.key)}"><input inputmode="decimal" placeholder="monthly $ limit (Go-style)" value="${m.limits ? m.limits.month.cap : ""}" aria-label="Monthly limit" /><button class="btn">set limit</button></form>
          <small class="dim">A monthly limit also caps 5h at 20 % and weekly at 50 %, like OpenCode Go.</small>
          <button class="btn ghost" data-use="${esc(m.key)}">use this model</button>
        </div>`
        : "";
      return `<li class="mrow ${open ? "open" : ""}">
        <button class="mrow-h" data-toggle="${esc(m.key)}">
          <span class="m-name"><b>${esc(m.name)}</b><small class="dim">${esc(m.providerName)}${m.status !== "active" ? ` · ${esc(m.status)}` : ""}</small></span>
          <span class="m-left">${left}<small class="dim">${m.spend ? `${money(m.spend.windows.month)} 30d` : ""}</small></span>
        </button>
        <small class="dim m-tok">${tok}</small>${lim}${detail}
      </li>`;
    })
    .join("");

  root.innerHTML = `
    <div class="tiles">
      <div class="tile"><small>today</small><b>${money(B.total.day)}</b></div>
      <div class="tile"><small>30 days</small><b>${money(B.total.month)}</b></div>
      <div class="tile"><small>all time</small><b>${money(B.total.cost)}</b></div>
      <div class="tile"><small>replies</small><b>${compact(B.total.requests)}</b></div>
    </div>
    <div class="section-h"><span>providers</span><button class="btn ghost" id="bal-refresh">↻ refresh</button></div>
    <div class="cards">${prov || `<p class="dim pad">No providers connected. Connect one in workspace 4.</p>`}</div>
    <div class="section-h"><span>models · balance left</span></div>
    <div class="toolbar"><input type="search" id="bal-q" placeholder="filter models…" value="${esc(balUi.q)}" aria-label="Filter models" />
      <label class="toggle"><input type="checkbox" id="bal-used" ${balUi.used ? "checked" : ""}/> used</label></div>
    <ul class="list models">${rows || `<li class="empty dim">no models match</li>`}</ul>
    <p class="dim small pad">“Balance left” is your provider balance (live from the provider API where one exists, otherwise the balance you set minus what opencode spent since), capped by any per-model limit. Token estimates use list price. Updated ${new Date(B.generatedAt).toLocaleTimeString()}.</p>`;
}

$("#balance").addEventListener("click", async (e) => {
  const t = e.target;
  if (t.id === "bal-refresh") {
    t.textContent = "…";
    buzz();
    return refreshBalances(true);
  }
  const tg = t.closest("[data-toggle]");
  if (tg) {
    const k = tg.dataset.toggle;
    balUi.open.has(k) ? balUi.open.delete(k) : balUi.open.add(k);
    return renderBalance();
  }
  if (t.dataset.use) {
    const [providerID, ...rest] = t.dataset.use.split("/");
    setModel({ providerID, modelID: rest.join("/") });
    toast("model selected", "ok");
    return goWs(0);
  }
  if (t.dataset.clearBalance) {
    const b = await api("/api/budgets");
    delete b.providers[t.dataset.clearBalance];
    await api("/api/budgets", { method: "PUT", body: b });
    return refreshBalances();
  }
});
$("#balance").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const val = Number(String($("input", f).value).replace(/[$,\s]/g, ""));
  try {
    const b = await api("/api/budgets");
    if (f.dataset.setBalance) {
      if (!Number.isFinite(val)) throw new Error("Enter a number");
      b.providers[f.dataset.setBalance] = { balance: val, currency: "USD", asOf: Date.now() };
    } else if (f.dataset.setLimit) {
      if (!$("input", f).value.trim() || val <= 0) delete b.limits[f.dataset.setLimit];
      else b.limits[f.dataset.setLimit] = { monthly: val };
    }
    await api("/api/budgets", { method: "PUT", body: b });
    toast("saved", "ok");
    buzz();
    refreshBalances();
  } catch (err) {
    toast(err.message, "error");
  }
});
$("#balance").addEventListener("input", (e) => {
  if (e.target.id === "bal-q") {
    balUi.q = e.target.value;
    clearTimeout(balTimer);
    balTimer = setTimeout(() => {
      renderBalance();
      const q = $("#bal-q");
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }, 200);
  }
  if (e.target.id === "bal-used") {
    balUi.used = e.target.checked;
    store.set("balUsed", balUi.used);
    renderBalance();
  }
});

// ── account ───────────────────────────────────────────────────────────────────────────
async function renderAccount() {
  const root = $("#account");
  try {
    [S.me, S.accounts] = await Promise.all([api("/api/me"), api("/api/accounts")]);
  } catch (e) {
    root.innerHTML = `<p class="bad pad">${esc(e.message)}</p>`;
    return;
  }
  const me = S.me;
  const B = S.balances;
  const nModels = S.providers.reduce((n, p) => n + Object.keys(p.models || {}).length, 0);
  const lines = [
    ["user", `${me.user.name}@opencode`],
    ["login", `since ${new Date(me.user.since).toLocaleDateString()}`],
    ["expires", new Date(me.user.expires).toLocaleDateString()],
    ["server", me.opencode.url],
    ["status", me.opencode.reachable ? "● online" : `○ offline (${me.opencode.error || "?"})`],
    ["project", me.opencode.worktree || "—"],
    ["providers", `${S.accounts.accounts.filter((a) => a.connected).length} connected`],
    ["models", String(nModels)],
    ["spent", B ? `${money(B.total.month)} 30d · ${money(B.total.cost)} total` : "…"],
    ["theme", THEMES[prefs.theme]?.name],
    ["bridge", `v${me.bridge.version}${me.bridge.demo ? " (demo)" : ""}`],
  ];
  const art = ["  ▄▄▄▄▄▄▄  ", " █ ▄▄▄▄▄ █ ", " █ █   █ █ ", " █ █▄▄▄█ █ ", " █▄▄▄▄▄▄▄█ ", "   ▀▀▀▀▀   "];
  const accs = S.accounts.accounts
    .map(
      (a) => `<li class="row acc"><div class="row-main static"><span class="row-title"><i class="dot ${a.connected ? "on" : ""}"></i>${esc(a.name)}</span>
        <small class="dim">${esc(a.type === "oauth" ? `oauth · ${a.expires ? (a.expires > Date.now() ? `token refreshes ${ago(a.expires) === "now" ? "soon" : new Date(a.expires).toLocaleString()}` : "token expired — opencode refreshes it on next use") : "signed in"}` : a.type === "env" ? "from environment variable" : `${a.type} key ${a.hint || ""}`)}</small></div>
        <button class="btn ghost" data-connect="${esc(a.id)}">${a.connected ? "re-auth" : "connect"}</button></li>`,
    )
    .join("");
  root.innerHTML = `
    <div class="fetch"><pre class="fetch-art" aria-hidden="true">${art.join("\n")}</pre>
      <div class="fetch-info"><b class="accent">${esc(me.user.name)}</b><span class="dim">@</span><b class="accent">opencode·pixel</b><div class="dim">${"─".repeat(22)}</div>
      ${lines.map(([k, v]) => `<div><span class="k">${k}</span> ${esc(v)}</div>`).join("")}
      <div class="swatch">${["red", "green", "yellow", "accent", "purple", "cyan", "fg"].map((c) => `<i style="background:var(--${c})"></i>`).join("")}</div></div></div>
    <div class="section-h"><span>provider logins</span><button class="btn primary" id="connect-new">+ connect</button></div>
    <ul class="list">${accs || `<li class="empty dim">No providers yet. Tap “connect” to log in to OpenCode Zen, Anthropic, OpenAI, OpenRouter…</li>`}</ul>
    ${me.bridge.authFileFound || me.bridge.demo ? "" : `<p class="dim small pad">Couldn't read ${esc(me.bridge.authFile)} — key hints and live balances need the bridge on the same machine as opencode (or set OPENCODE_AUTH_FILE).</p>`}
    <div class="section-h"><span>session</span></div>
    <div class="pad stack">
      <a class="btn" href="https://opencode.ai/console" target="_blank" rel="noopener">OpenCode console (Zen billing) ↗</a>
      <button class="btn danger" id="logout">log out of this phone</button>
    </div>`;
  $("#connect-new").addEventListener("click", () => connectFlow());
  $$("[data-connect]", root).forEach((b) => b.addEventListener("click", () => connectFlow(b.dataset.connect)));
  $("#logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    showLogin();
  });
}

// Log in to a model provider through opencode (OAuth or API key), from the phone.
function connectFlow(providerID) {
  const avail = S.accounts?.available || [];
  const body = h(`<div class="picker"><input type="search" class="picker-q" placeholder="search providers…" aria-label="Search providers" /><div class="picker-list"></div></div>`);
  const list = $(".picker-list", body);
  const choose = (p) => {
    list.innerHTML = "";
    $(".picker-q", body).hidden = true;
    list.append(h(`<p class="pad"><b>${esc(p.name)}</b> — how do you want to sign in?</p>`));
    p.methods.forEach((m, idx) => {
      const b = h(`<button class="pick"><span class="pick-main"><b>${esc(m.label)}</b><small class="dim">${m.type === "oauth" ? "opens the provider's sign-in page" : "paste an API key"}</small></span><span class="pick-side">›</span></button>`);
      b.addEventListener("click", () => (m.type === "oauth" ? oauth(p, idx) : apiKey(p)));
      list.append(b);
    });
  };
  const apiKey = (p) => {
    list.innerHTML = "";
    const f = h(`<form class="stack pad"><p><b>${esc(p.name)}</b> API key</p><input type="password" autocomplete="off" placeholder="sk-…" required aria-label="API key" />
      <small class="dim">Sent once to your opencode server (stored in its auth.json). It never stays on the phone.</small><button class="btn primary">save key</button></form>`);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await oc(`/auth/${encodeURIComponent(p.id)}`, { method: "PUT", body: { type: "api", key: $("input", f).value.trim() } });
        done(p);
      } catch (err) {
        toast(err.message, "error");
      }
    });
    list.append(f);
    $("input", f).focus();
  };
  const oauth = async (p, method) => {
    list.innerHTML = `<p class="pad"><span class="spin"></span> starting sign-in…</p>`;
    try {
      const a = await oc(`/provider/${encodeURIComponent(p.id)}/oauth/authorize`, { method: "POST", body: { method } });
      list.innerHTML = "";
      const f = h(`<form class="stack pad"><p><b>${esc(p.name)}</b></p><a class="btn primary" href="${esc(a.url)}" target="_blank" rel="noopener">open sign-in page ↗</a>
        ${a.instructions ? `<p class="dim">${esc(a.instructions)}</p>` : ""}
        ${a.method === "code" ? `<input placeholder="paste the code here" autocomplete="off" required aria-label="Authorization code" /><button class="btn">finish</button>` : `<p class="dim"><span class="spin"></span> waiting for you to finish in the browser…</p>`}</form>`);
      list.append(f);
      if (a.method === "code") {
        f.addEventListener("submit", async (e) => {
          e.preventDefault();
          try {
            await oc(`/provider/${encodeURIComponent(p.id)}/oauth/callback`, { method: "POST", body: { method, code: $("input", f).value.trim() } });
            done(p);
          } catch (err) {
            toast(err.message, "error");
          }
        });
      } else {
        await oc(`/provider/${encodeURIComponent(p.id)}/oauth/callback`, { method: "POST", body: { method } });
        done(p);
      }
    } catch (err) {
      list.innerHTML = `<p class="bad pad">${esc(err.message)}</p>`;
    }
  };
  const done = (p) => {
    toast(`${p.name} connected`, "ok");
    buzz([10, 40, 10]);
    closeSheet();
    renderAccount();
    loadModels();
    refreshBalances(true);
  };
  const draw = (q = "") => {
    list.innerHTML = "";
    q = q.toLowerCase();
    const popular = ["opencode", "anthropic", "openai", "github-copilot", "openrouter", "google", "deepseek", "xai", "groq"];
    const items = avail.filter((p) => !q || `${p.name} ${p.id}`.toLowerCase().includes(q)).sort((a, b) => ((popular.indexOf(a.id) + 1 || 99) - (popular.indexOf(b.id) + 1 || 99)) || a.name.localeCompare(b.name));
    for (const p of items.slice(0, 80)) {
      const b = h(`<button class="pick"><span class="pick-main"><b>${esc(p.name)}</b><small class="dim">${esc(p.id)}${p.methods.some((m) => m.type === "oauth") ? " · sign-in available" : ""}</small></span><span class="pick-side">›</span></button>`);
      b.addEventListener("click", () => choose(p));
      list.append(b);
    }
    if (!items.length) list.append(h(`<p class="dim pad">no match</p>`));
  };
  $(".picker-q", body).addEventListener("input", (e) => draw(e.target.value));
  const pre = providerID && avail.find((p) => p.id === providerID);
  openSheet("connect provider", body);
  pre ? choose(pre) : draw();
}

// ── settings ──────────────────────────────────────────────────────────────────────────
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvt = e;
  renderSettings();
});

function renderSettings() {
  const root = $("#settings");
  const sw = Object.entries(THEMES)
    .map(([id, t]) => `<button class="theme ${prefs.theme === id ? "sel" : ""}" data-theme="${id}" style="--t-bg:${t.bg};--t-fg:${t.fg};--t-a:${t.accent};--t-b:${t.surface}"><span class="tp"><i style="background:${t.red}"></i><i style="background:${t.green}"></i><i style="background:${t.yellow}"></i><i style="background:${t.accent}"></i><i style="background:${t.purple}"></i></span><span>${esc(t.name)}</span></button>`)
    .join("");
  const tog = (k, label, hint = "") => `<label class="switch"><span><b>${label}</b>${hint ? `<small class="dim">${hint}</small>` : ""}</span><input type="checkbox" data-pref="${k}" ${prefs[k] ? "checked" : ""}/><i></i></label>`;
  root.innerHTML = `
    <div class="section-h"><span>theme</span></div>
    <div class="themes">${sw}</div>
    <div class="section-h"><span>text size · ${Math.round(prefs.fontScale * 100)}%</span></div>
    <div class="pad"><input type="range" min="0.85" max="1.3" step="0.05" value="${prefs.fontScale}" id="scale" aria-label="Text size" /></div>
    <div class="section-h"><span>behaviour</span></div>
    <div class="switches">
      ${tog("haptics", "haptics", "small vibrations on taps")}
      ${tog("notify", "notify when done", "when a reply finishes while the app is in the background")}
      ${tog("wakeLock", "keep screen on", "while opencode is working")}
      ${tog("enterSends", "enter sends", "otherwise enter = newline, use the send button")}
      ${tog("showReasoning", "show thinking", "model reasoning blocks")}
    </div>
    <div class="section-h"><span>app</span></div>
    <div class="pad stack">
      ${installEvt ? `<button class="btn primary" id="install">install on home screen</button>` : matchMedia("(display-mode: standalone)").matches ? `<p class="dim">installed ✓</p>` : `<p class="dim">To install: Chrome menu ⋮ → “Add to Home screen” → Install.</p>`}
      <button class="btn" id="reload-oc">reload opencode (picks up new logins/config)</button>
      <button class="btn ghost" id="clear-cache">clear app cache</button>
      <p class="dim small">shortcuts with a keyboard: Ctrl+K launcher · Alt+1…5 workspaces · Ctrl+Enter send</p>
    </div>`;
}

$("#settings").addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.theme) {
    prefs.theme = t.dataset.theme;
    savePrefs();
    applyTheme(prefs.theme);
    buzz();
    renderSettings();
    toast(`theme: ${THEMES[prefs.theme].name}`);
  } else if (t.id === "install" && installEvt) {
    installEvt.prompt();
    await installEvt.userChoice;
    installEvt = null;
    renderSettings();
  } else if (t.id === "reload-oc") {
    if (!confirm("Reload the opencode instance? Running replies will stop.")) return;
    await oc("/instance/dispose", { method: "POST" }).catch((err) => toast(err.message, "error"));
    setTimeout(loadAll, 800);
    toast("opencode reloaded", "ok");
  } else if (t.id === "clear-cache") {
    for (const k of (await caches?.keys?.()) || []) await caches.delete(k);
    (await navigator.serviceWorker?.getRegistration())?.unregister();
    location.reload();
  }
});
$("#settings").addEventListener("change", async (e) => {
  const k = e.target.dataset.pref;
  if (k) {
    prefs[k] = e.target.checked;
    if (k === "notify" && prefs.notify && "Notification" in window && Notification.permission !== "granted") {
      prefs.notify = (await Notification.requestPermission()) === "granted";
      e.target.checked = prefs.notify;
    }
    savePrefs();
    buzz();
    if (k === "showReasoning") renderChat();
  }
});
$("#settings").addEventListener("input", (e) => {
  if (e.target.id === "scale") {
    prefs.fontScale = Number(e.target.value);
    document.documentElement.style.setProperty("--scale", prefs.fontScale);
    $("#settings .section-h:nth-of-type(2) span").textContent = `text size · ${Math.round(prefs.fontScale * 100)}%`;
    savePrefs();
  }
});

// ── sheet ─────────────────────────────────────────────────────────────────────────────
function initSheet() {
  $("#sheet").addEventListener("click", (e) => e.target.id === "sheet" && closeSheet());
  // drag the grip down to dismiss
  let y0 = null;
  const sheet = $("#sheet .sheet");
  $(".sheet-grip").addEventListener("touchstart", (e) => (y0 = e.touches[0].clientY), { passive: true });
  $(".sheet-grip").addEventListener("touchmove", (e) => y0 !== null && (sheet.style.transform = `translateY(${Math.max(0, e.touches[0].clientY - y0)}px)`), { passive: true });
  $(".sheet-grip").addEventListener("touchend", (e) => {
    const dy = e.changedTouches[0].clientY - y0;
    y0 = null;
    sheet.style.transform = "";
    if (dy > 80) closeSheet();
  });
}
function openSheet(label, body) {
  $("#sheet-label").textContent = label;
  $("#sheet-body").replaceChildren(body);
  $("#sheet").hidden = false;
  history.pushState({ overlay: "sheet" }, "");
  setTimeout(() => $("input:not([type=hidden])", body)?.focus({ preventScroll: true }), 50);
}
function closeSheet(fromPop = false) {
  if ($("#sheet").hidden) return;
  $("#sheet").hidden = true;
  $("#sheet-body").replaceChildren();
  if (!fromPop && history.state?.overlay) history.back();
}

// Android back gesture closes overlays instead of leaving the app.
window.addEventListener("popstate", () => {
  closeSheet(true);
  closeWalker(true);
});

// ── walker (launcher) ─────────────────────────────────────────────────────────────────
let walkerSel = 0;
function walkerItems(q) {
  const items = [
    { icon: "+", label: "new session", run: () => (newChat(), goWs(0)) },
    { icon: "◇", label: "pick model", run: () => openModelPicker() },
    { icon: "$", label: "balance per model", run: () => goWs(2) },
    { icon: "↻", label: "refresh balances", run: () => (refreshBalances(true), goWs(2)) },
    { icon: "⚿", label: "connect provider", run: () => (goWs(3), S.accounts ? connectFlow() : renderAccount().then(() => connectFlow())) },
    { icon: "⇄", label: `switch agent (${S.agent})`, run: () => $("#agent-chip").click() },
    ...WORKSPACES.map((w, i) => ({ icon: String(w.n), label: `workspace ${w.n} · ${w.label}`, run: () => goWs(i) })),
    ...Object.entries(THEMES).map(([id, t]) => ({ icon: "◐", label: `theme: ${t.name}`, run: () => ((prefs.theme = id), savePrefs(), applyTheme(id), renderSettings()) })),
    ...S.sessions.slice(0, 50).map((s) => ({ icon: "›", label: s.title, hint: ago(s.time.updated), run: () => (openSession(s.id), goWs(0)) })),
    { icon: "⏻", label: "log out", run: () => api("/api/logout", { method: "POST" }).finally(showLogin) },
  ];
  if (!q) return items.slice(0, 12 + Math.min(8, S.sessions.length));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => words.every((w) => it.label.toLowerCase().includes(w)));
}
function drawWalker() {
  const items = walkerItems($("#walker-q").value.trim());
  walkerSel = Math.min(walkerSel, Math.max(0, items.length - 1));
  const ul = $("#walker-list");
  ul.innerHTML = "";
  items.forEach((it, i) => {
    const li = h(`<li><button class="${i === walkerSel ? "sel" : ""}"><span class="w-icon">${esc(it.icon)}</span><span class="w-label">${esc(it.label)}</span>${it.hint ? `<small class="dim">${esc(it.hint)}</small>` : ""}</button></li>`);
    li.firstChild.addEventListener("click", () => {
      closeWalker();
      it.run();
    });
    ul.append(li);
  });
  ul._items = items;
}
function initWalker() {
  $("#walker").addEventListener("click", (e) => e.target.id === "walker" && closeWalker());
  $("#walker-q").addEventListener("input", () => {
    walkerSel = 0;
    drawWalker();
  });
  $("#walker-q").addEventListener("keydown", (e) => {
    const items = $("#walker-list")._items || [];
    if (e.key === "ArrowDown") walkerSel = Math.min(items.length - 1, walkerSel + 1);
    else if (e.key === "ArrowUp") walkerSel = Math.max(0, walkerSel - 1);
    else if (e.key === "Enter" && items[walkerSel]) {
      closeWalker();
      return items[walkerSel].run();
    } else return;
    e.preventDefault();
    drawWalker();
  });
}
function openWalker() {
  if (!$("#walker").hidden) return closeWalker();
  $("#walker-q").value = "";
  walkerSel = 0;
  drawWalker();
  $("#walker").hidden = false;
  history.pushState({ overlay: "walker" }, "");
  buzz();
  setTimeout(() => $("#walker-q").focus(), 30);
}
function closeWalker(fromPop = false) {
  if ($("#walker").hidden) return;
  $("#walker").hidden = true;
  if (!fromPop && history.state?.overlay) history.back();
}

// ── service worker ────────────────────────────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open-session" && e.data.sessionID) {
      openSession(e.data.sessionID);
      goWs(0);
    }
  });
}

boot();
