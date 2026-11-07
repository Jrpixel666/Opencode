// opencode·pixel — phone client for `opencode serve`, in the style of the Claude Android app.
import { api, oc, onUnauthorized } from "./js/api.js";
import { markdown, esc } from "./js/markdown.js";
import { applyAppearance, onSystemAppearanceChange } from "./js/themes.js";
import { I } from "./js/icons.js";

// ── helpers ───────────────────────────────────────────────────────────────────────────
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
      /* private mode */
    }
  },
};

// Present when running inside the Android app (android/), which adds native features.
const native = window.OpencodeAndroid || null;

const prefs = { appearance: "system", fontScale: 1, haptics: true, notify: false, wakeLock: true, enterSends: false, showReasoning: true, ...store.get("prefs", {}) };
const savePrefs = () => store.set("prefs", prefs);
const buzz = (ms = 8) => prefs.haptics && navigator.vibrate?.(ms);

function money(n, cur = "USD") {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  const s = abs.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n < 0 ? "−" : ""}${cur === "USD" ? "$" + s : `${s} ${cur}`}`;
}
function compact(n) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}
function ago(t) {
  if (!t) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Snackbar, Android style.
function toast(text, kind = "info", ms = 3200) {
  const el = h(`<div class="toast ${kind}"></div>`);
  el.textContent = text;
  $("#toasts").append(el);
  el.addEventListener("click", () => el.remove());
  setTimeout(() => el.classList.add("out"), ms);
  setTimeout(() => el.remove(), ms + 300);
}

// Fill static icon slots.
$$("[data-i]").forEach((el) => (el.innerHTML = I[el.dataset.i] || ""));
$("#menu-btn").innerHTML = I.menu;
$("#new-btn").innerHTML = I.compose;
$("#title-chev").innerHTML = I.down;
$("#attach-btn").innerHTML = I.plus;
$("#jump").innerHTML = I.down;
$("#bal-refresh").innerHTML = I.refresh;
$$(".pagebar .back").forEach((b) => (b.innerHTML = I.back));
$("#login-mark").innerHTML = I.mark;
$("#drawer-mark").innerHTML = I.mark;

// ── state ─────────────────────────────────────────────────────────────────────────────
const S = {
  me: null,
  sessions: [],
  status: {},
  current: store.get("session", null),
  msgs: new Map(),
  perms: new Map(),
  providers: [],
  model: store.get("model", null),
  agents: [],
  agent: store.get("agent", "build"),
  balances: null,
  accounts: null,
  attachments: [],
};

// ── appearance ────────────────────────────────────────────────────────────────────────
applyAppearance(prefs.appearance);
onSystemAppearanceChange(() => applyAppearance(prefs.appearance));
document.documentElement.style.setProperty("--scale", prefs.fontScale);

// ── layers: drawer / pages / sheet, closed by the Android back gesture ────────────────
const layers = [];
function pushLayer(name, close, { replace = false } = {}) {
  if (replace && layers.length) {
    layers[layers.length - 1].close(true);
    layers[layers.length - 1] = { name, close };
    history.replaceState({ layer: layers.length }, "");
  } else {
    layers.push({ name, close });
    history.pushState({ layer: layers.length }, "");
  }
}
function popLayer() {
  if (layers.length) history.back();
}
window.addEventListener("popstate", () => {
  const l = layers.pop();
  l?.close();
});
const topLayer = () => layers[layers.length - 1]?.name;

// drawer
function openDrawer() {
  if (topLayer() === "drawer") return;
  renderRecents();
  showDrawer(true);
  pushLayer("drawer", () => showDrawer(false));
  buzz(5);
}
function showDrawer(on) {
  const d = $("#drawer");
  d.classList.toggle("open", on);
  d.style.transform = "";
  d.toggleAttribute("inert", !on);
  $("#scrim").hidden = !on;
}
$("#menu-btn").addEventListener("click", openDrawer);
$("#scrim").addEventListener("click", popLayer);

// Swipe right on the chat opens the drawer; swipe left on the drawer closes it.
(() => {
  const d = $("#drawer");
  let x0 = null, y0 = 0, dx = 0, mode = null, locked = false;
  document.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    const open = d.classList.contains("open");
    if (!open && (topLayer() || $("#app").hidden || !e.target.closest("#chat") || e.target.closest("pre, .table, .t-out, .att"))) return;
    if (open && !d.contains(e.target) && e.target.id !== "scrim") return;
    x0 = t.clientX; y0 = t.clientY; dx = 0; locked = false; mode = open ? "close" : "open";
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (x0 === null) return;
    dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (!locked) {
      if (Math.hypot(dx, dy) < 12) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.5 || (mode === "open" && dx < 0)) return (x0 = null);
      locked = true;
    }
    const w = d.offsetWidth;
    const off = mode === "open" ? Math.min(0, -w + dx) : Math.min(0, dx);
    d.classList.add("dragging");
    d.style.transform = `translateX(${off}px)`;
    if (mode === "open") $("#scrim").hidden = false;
  }, { passive: true });
  document.addEventListener("touchend", () => {
    if (x0 === null) return;
    x0 = null;
    if (!locked) return;
    d.classList.remove("dragging");
    d.style.transform = "";
    if (mode === "open") dx > 70 ? openDrawer() : ($("#scrim").hidden = true);
    else if (dx < -70) popLayer();
  });
})();

// pages
const PAGES = { balance: renderBalance, account: renderAccount, settings: renderSettings };
function openPage(name) {
  const el = $(`#page-${name}`);
  el.hidden = false;
  el.classList.remove("closing");
  // Coming from the drawer, the page takes the drawer's place so one "back" returns to chat.
  pushLayer(`page:${name}`, (instant) => {
    if (instant) return (el.hidden = true);
    el.classList.add("closing");
    setTimeout(() => (el.hidden = true), 190);
  }, { replace: topLayer() === "drawer" });
  if (name === "balance") refreshBalances();
  else PAGES[name]();
}
$$("[data-page]").forEach((b) => b.addEventListener("click", () => openPage(b.dataset.page)));
$$(".pagebar .back").forEach((b) => b.addEventListener("click", popLayer));

// sheet
function openSheet(title, body) {
  $("#sheet-label").textContent = title;
  $("#sheet-body").replaceChildren(body);
  $("#sheet").hidden = false;
  pushLayer("sheet", () => {
    $("#sheet").hidden = true;
    $("#sheet-body").replaceChildren();
  });
}
const closeSheet = () => topLayer() === "sheet" && popLayer();
$("#sheet").addEventListener("click", (e) => e.target.id === "sheet" && closeSheet());
(() => {
  let y0 = null;
  const sheet = $("#sheet .sheet");
  const grip = $(".sheet-grip");
  grip.addEventListener("touchstart", (e) => (y0 = e.touches[0].clientY), { passive: true });
  grip.addEventListener("touchmove", (e) => y0 !== null && (sheet.style.transform = `translateY(${Math.max(0, e.touches[0].clientY - y0)}px)`), { passive: true });
  grip.addEventListener("touchend", (e) => {
    const dy = e.changedTouches[0].clientY - y0;
    y0 = null;
    sheet.style.transform = "";
    if (dy > 80) closeSheet();
  });
})();

// ── boot & login ──────────────────────────────────────────────────────────────────────
onUnauthorized(() => showLogin());

async function boot() {
  try {
    S.me = await api("/api/me");
  } catch (e) {
    if (e.status !== 401) toast(`Can't reach the bridge: ${e.message}`, "error", 8000);
    return showLogin();
  }
  start();
}

function showLogin() {
  stopEvents();
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-host").textContent = `Sign in to opencode on ${location.host}`;
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
function start() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  if (!started) {
    started = true;
    initComposer();
  }
  renderProfile();
  handleShare();
  startEvents();
  loadAll().then(() => {
    // Deep links from shortcuts and notifications: ?page=balance, ?session=…, ?new=1
    const q = new URLSearchParams(location.search);
    if (q.get("session")) openSession(q.get("session"));
    else if (q.has("new")) newChat();
    if (PAGES[q.get("page")]) openPage(q.get("page"));
    if (location.search) history.replaceState(history.state, "", "/");
  });
}

async function loadAll() {
  await Promise.allSettled([loadModels(), loadSessions()]);
  if (S.current && S.sessions.some((s) => s.id === S.current)) await openSession(S.current, false);
  else renderChat();
  refreshBalances();
}

function renderProfile() {
  const name = S.me?.user?.name || "me";
  $("#avatar").textContent = name[0];
  $("#profile-name").textContent = name;
  const left = S.balances?.providers?.reduce((s, p) => s + (Number.isFinite(p.balance.amount) && p.balance.currency === "USD" ? p.balance.amount : 0), 0);
  $("#profile-sub").textContent = left ? `${money(left)} available` : S.me?.opencode?.reachable === false ? "opencode offline" : "Settings";
  $("#nav-balance").textContent = left ? money(left) : "";
}

// ── live events (SSE) ─────────────────────────────────────────────────────────────────
let es = null;
let retry = 1000;
let online = true;
function startEvents() {
  stopEvents();
  es = new EventSource("/api/oc/event");
  es.onopen = () => {
    retry = 1000;
    if (!online) toast("Reconnected");
    online = true;
  };
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch (err) {
      console.warn("bad event", err);
    }
  };
  es.onerror = () => {
    es?.close();
    es = null;
    if (online) toast("Connection lost — retrying…", "error");
    online = false;
    setTimeout(async () => {
      if (es || $("#app").hidden) return;
      try {
        await api("/api/me");
        startEvents();
        loadSessions();
        if (S.current) loadMessages(S.current);
      } catch {
        retry = Math.min(retry * 2, 30_000);
        setTimeout(() => !es && !$("#app").hidden && startEvents(), retry);
      }
    }, retry);
  };
}
function stopEvents() {
  es?.close();
  es = null;
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !$("#app").hidden && !es) startEvents();
});

function onEvent({ type, properties: p }) {
  switch (type) {
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
      break;
    case "session.idle":
      S.status[p.sessionID] = { type: "idle" };
      updateBusy();
      notifyDone(p.sessionID);
      break;
    case "session.created":
    case "session.updated": {
      if (p.info.parentID) break;
      const i = S.sessions.findIndex((s) => s.id === p.info.id);
      if (i >= 0) S.sessions[i] = p.info;
      else S.sessions.unshift(p.info);
      S.sessions.sort((a, b) => b.time.updated - a.time.updated);
      if (topLayer() === "drawer") renderRecents();
      if (p.info.id === S.current) renderTitle();
      break;
    }
    case "session.deleted":
      S.sessions = S.sessions.filter((s) => s.id !== p.info.id);
      if (topLayer() === "drawer") renderRecents();
      if (p.info.id === S.current) newChat();
      break;
    case "session.error":
      if (!p.sessionID || p.sessionID === S.current) toast(p.error?.data?.message || p.error?.name || "Something went wrong", "error", 7000);
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
  renderComposerBar();
}

function modelInfo(m = S.model) {
  if (!m) return null;
  const p = S.providers.find((x) => x.id === m.providerID);
  return p?.models?.[m.modelID] ? { provider: p, model: p.models[m.modelID] } : null;
}
function setModel(m) {
  S.model = m;
  store.set("model", m);
  renderComposerBar();
}

function renderComposerBar() {
  const mi = modelInfo();
  $("#model-chip").innerHTML = `<span>${esc(mi ? mi.model.name : "Choose model")}</span>${I.down}`;
  $("#agent-chip").textContent = S.agent[0].toUpperCase() + S.agent.slice(1);
  $("#agent-chip").dataset.agent = S.agent;
  updateSendBtn();
}

function openModelPicker() {
  const byKey = Object.fromEntries((S.balances?.models || []).map((m) => [m.key, m]));
  const body = h(`<div><input type="search" placeholder="Search models" aria-label="Search models" /><div class="list"></div></div>`);
  const list = $(".list", body);
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
        const left = free ? `<span class="ok">Free</span>` : Number.isFinite(b?.spendable) ? `<span class="${b.spendable <= 0 ? "bad" : ""}">${money(b.spendable, b.currency)} left</span>` : "";
        const feats = [`${compact(m.limit?.context || 0)} context`, m.capabilities?.reasoning && "thinking", m.capabilities?.attachment && "images"].filter(Boolean).join(" · ");
        const row = h(`<button class="pick ${sel ? "sel" : ""}"><span class="pick-check">${sel ? I.check : ""}</span>
          <span class="pick-main"><b>${esc(m.name)}</b><small>${feats}</small></span>
          <span class="pick-side">${left}<small class="muted">${free ? "" : `$${m.cost.input} / $${m.cost.output}`}</small></span></button>`);
        row.addEventListener("click", () => {
          setModel({ providerID: p.id, modelID: m.id });
          buzz();
          closeSheet();
        });
        list.append(row);
      }
    }
    if (!list.children.length) list.append(h(`<p class="muted pad">No models yet. Connect a provider in Account.</p>`));
  };
  draw();
  $("input", body).addEventListener("input", (e) => draw(e.target.value));
  openSheet("Choose a model", body);
  setTimeout(() => $(".pick.sel", body)?.scrollIntoView({ block: "center" }), 60);
}
$("#model-chip").addEventListener("click", openModelPicker);

$("#agent-chip").addEventListener("click", () => {
  const body = h(`<div class="menu"></div>`);
  for (const a of S.agents) {
    const sel = a.name === S.agent;
    const desc = a.description || (a.name === "plan" ? "Reads and plans, doesn't change files" : a.name === "build" ? "Can edit files and run commands" : "");
    const b = h(`<button class="pick ${sel ? "sel" : ""}"><span class="pick-check">${sel ? I.check : ""}</span><span class="pick-main"><b>${esc(a.name[0].toUpperCase() + a.name.slice(1))}</b>${desc ? `<small>${esc(desc)}</small>` : ""}</span></button>`);
    b.addEventListener("click", () => {
      S.agent = a.name;
      store.set("agent", a.name);
      renderComposerBar();
      buzz();
      closeSheet();
    });
    body.append(b);
  }
  openSheet("Agent", body);
});

// ── sessions (drawer recents) ─────────────────────────────────────────────────────────
async function loadSessions() {
  const [list, status] = await Promise.all([oc("/session"), oc("/session/status").catch(() => ({}))]);
  S.sessions = (list || []).filter((s) => !s.parentID).sort((a, b) => b.time.updated - a.time.updated);
  S.status = status || {};
  updateBusy();
}

function renderRecents() {
  const ul = $("#recents");
  const q = $("#session-filter").value.toLowerCase();
  ul.innerHTML = "";
  const rows = S.sessions.filter((s) => !q || s.title.toLowerCase().includes(q));
  for (const s of rows) {
    const busy = ["busy", "retry"].includes(S.status[s.id]?.type);
    const li = h(`<li class="recent ${s.id === S.current ? "sel" : ""}"><button class="recent-main">${busy ? '<i class="spin"></i>' : ""}<span>${esc(s.title)}</span></button><button class="icon-btn" aria-label="Options for ${esc(s.title)}">${I.more}</button></li>`);
    const main = li.querySelector(".recent-main");
    main.addEventListener("click", () => {
      popLayer();
      openSession(s.id);
    });
    let lp;
    main.addEventListener("touchstart", () => (lp = setTimeout(() => (buzz(20), sessionMenu(s)), 550)), { passive: true });
    main.addEventListener("touchend", () => clearTimeout(lp));
    main.addEventListener("touchmove", () => clearTimeout(lp), { passive: true });
    li.querySelector(".icon-btn").addEventListener("click", () => sessionMenu(s));
    ul.append(li);
  }
  if (!rows.length) ul.append(h(`<li class="empty">${q ? "No matching chats" : "Your chats will show up here"}</li>`));
}
$("#session-filter").addEventListener("input", renderRecents);
$("#nav-new").addEventListener("click", () => {
  popLayer();
  newChat();
});
$("#new-btn").addEventListener("click", () => {
  buzz();
  newChat();
});
$("#title-btn").addEventListener("click", () => {
  const s = S.sessions.find((x) => x.id === S.current);
  s ? sessionMenu(s) : openModelPicker();
});

function sessionMenu(s) {
  const body = h(`<div class="menu">
    <form class="stack" style="padding:0 8px 8px"><input value="${esc(s.title)}" maxlength="120" aria-label="Chat title" /><button class="btn">Rename</button></form>
    ${s.share?.url ? `<a class="pick" href="${esc(s.share.url)}" target="_blank" rel="noopener"><span class="nav-ico">${I.share}</span><span class="pick-main"><b>Open share link</b></span></a>` : `<button class="pick" data-a="share"><span class="nav-ico">${I.share}</span><span class="pick-main"><b>Share</b><small>Create a public link</small></span></button>`}
    <button class="pick danger" data-a="delete"><span class="nav-ico">${I.trash}</span><span class="pick-main"><b>Delete</b></span></button></div>`);
  $("form", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await oc(`/session/${s.id}`, { method: "PATCH", body: { title: $("input", body).value.trim() || s.title } });
      toast("Renamed");
      closeSheet();
      await loadSessions();
      renderTitle();
      if (layers.some((l) => l.name === "drawer")) renderRecents();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  body.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (!a) return;
    try {
      if (a === "share") {
        const r = await oc(`/session/${s.id}/share`, { method: "POST" });
        if (r?.share?.url) {
          await navigator.clipboard?.writeText(r.share.url).catch(() => {});
          toast("Share link copied");
        }
      }
      if (a === "delete") {
        if (!confirm(`Delete “${s.title}”?`)) return;
        await oc(`/session/${s.id}`, { method: "DELETE" });
        S.sessions = S.sessions.filter((x) => x.id !== s.id);
        if (S.current === s.id) newChat();
        toast("Chat deleted");
      }
      closeSheet();
      if (topLayer() === "drawer") renderRecents();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  openSheet(s.title, body);
}

function newChat() {
  S.current = null;
  store.set("session", null);
  S.msgs.clear();
  renderChat();
  $("#prompt").focus();
}

async function openSession(id, focus = true) {
  S.current = id;
  store.set("session", id);
  S.msgs.clear();
  renderChat();
  await loadMessages(id);
  if (focus) buzz();
}

async function loadMessages(id) {
  try {
    const list = await oc(`/session/${id}/message`);
    if (S.current !== id) return;
    S.msgs.clear();
    for (const { info, parts } of list || []) S.msgs.set(info.id, { info, parts: new Map(parts.map((p) => [p.id, p])) });
    const lastUser = [...S.msgs.values()].reverse().find((m) => m.info.role === "user");
    if (lastUser?.info.model && modelInfo(lastUser.info.model)) setModel(lastUser.info.model);
    renderChat();
    scrollChat(false);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── chat rendering ────────────────────────────────────────────────────────────────────
function renderTitle() {
  const s = S.sessions.find((x) => x.id === S.current);
  $("#chat-title").textContent = s ? s.title.replace(/^New session - .*$/, "New chat") : "New chat";
  $("#title-chev").hidden = !s;
}

function greeting() {
  const hr = new Date().getHours();
  const part = hr < 5 ? "Hello, night owl" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  return `${part}, ${S.me?.user?.name || "there"}`;
}

const SUGGESTIONS = ["Explain this codebase", "Find and fix a bug", "Write tests for recent changes", "What changed since yesterday?"];

function renderChat() {
  renderTitle();
  const log = $("#chat-log");
  log.innerHTML = "";
  const msgs = sortedMsgs();
  if (!msgs.length) {
    const dir = S.me?.opencode?.worktree;
    const el = h(`<div class="greeting">${I.mark}<h2>${esc(greeting())}</h2>
      <p>${dir ? `Working in ${esc(dir.split("/").slice(-2).join("/"))}` : "Ask opencode about your project"}${modelInfo() ? "" : " · connect a provider in Account to start"}</p>
      <div class="suggest">${SUGGESTIONS.map((s) => `<button type="button">${esc(s)}</button>`).join("")}</div></div>`);
    $$(".suggest button", el).forEach((b) =>
      b.addEventListener("click", () => {
        $("#prompt").value = b.textContent;
        $("#prompt").dispatchEvent(new Event("input"));
        $("#prompt").focus();
      }),
    );
    log.append(el);
  }
  for (const m of msgs) log.append(renderMsg(m));
  renderPerms();
  updateBusy();
}

function sortedMsgs() {
  return [...S.msgs.values()].sort((a, b) => (a.info.time?.created || 0) - (b.info.time?.created || 0) || (a.info.id < b.info.id ? -1 : 1));
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
  $(".greeting", log)?.remove();
  for (const id of pending) {
    const m = S.msgs.get(id);
    if (!m) continue;
    const el = renderMsg(m);
    const old = $(`#m-${CSS.escape(id)}`, log);
    if (old) {
      // keep open/closed state of collapsible steps while streaming
      const open = new Set($$("details[open]", old).map((d) => d.dataset.k));
      $$("details", el).forEach((d) => open.has(d.dataset.k) && (d.open = true));
      old.replaceWith(el);
    } else {
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
  return log.scrollHeight - log.scrollTop - log.clientHeight < 140;
}
function scrollChat(smooth = true) {
  const log = $("#chat-log");
  log.scrollTo({ top: log.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  $("#jump").hidden = true;
}
$("#jump").addEventListener("click", () => scrollChat());
$("#chat-log").addEventListener("scroll", () => nearBottom() && ($("#jump").hidden = true), { passive: true });

$("#chat-log").addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (b) {
    const code = b.closest(".code")?.querySelector("code")?.textContent ?? "";
    return copyText(code, () => {
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1200);
    });
  }
  const c = e.target.closest("[data-copy-msg]");
  if (c) {
    const m = S.msgs.get(c.dataset.copyMsg);
    const text = [...(m?.parts.values() || [])].filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n\n");
    copyText(text, () => {
      c.innerHTML = I.check;
      setTimeout(() => (c.innerHTML = I.copy), 1200);
    });
  }
});
function copyText(text, done) {
  navigator.clipboard?.writeText(text).then(() => {
    buzz();
    done?.();
  });
}

const TOOL_LABEL = {
  bash: ["Ran", I.terminal],
  read: ["Read", I.doc],
  write: ["Wrote", I.pencil],
  edit: ["Edited", I.pencil],
  glob: ["Searched files", I.search],
  grep: ["Searched", I.search],
  list: ["Listed", I.list],
  webfetch: ["Fetched", I.globe],
  task: ["Delegated", I.tool],
  todowrite: ["Updated plan", I.list],
  todoread: ["Read plan", I.list],
};

function toolSummary(part) {
  const i = part.state?.input || {};
  const root = S.me?.opencode?.directory;
  const rel = (p) => (root && String(p || "").startsWith(root + "/") ? String(p).slice(root.length + 1) : String(p || ""));
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
    case "list":
      return rel(i.path);
    case "webfetch":
      return i.url;
    case "task":
      return i.description;
    case "todowrite":
      return `${(i.todos || []).length} steps`;
    default:
      return part.state?.title || "";
  }
}

function renderPart(part) {
  switch (part.type) {
    case "text":
      if (part.synthetic || part.ignored || !part.text) return "";
      return `<div class="md">${markdown(part.text)}</div>`;
    case "reasoning": {
      if (!prefs.showReasoning || !part.text?.trim()) return "";
      const secs = part.time?.end ? Math.max(1, Math.round((part.time.end - part.time.start) / 1000)) : null;
      return `<details class="reasoning" data-k="${esc(part.id)}"><summary>${secs ? `Thought for ${secs}s` : "Thinking…"}</summary><div class="md">${markdown(part.text)}</div></details>`;
    }
    case "tool": {
      const st = part.state?.status || "pending";
      const [label, icon] = TOOL_LABEL[part.tool] || [part.tool, I.tool];
      const out = st === "completed" ? part.state.output : st === "error" ? part.state.error : "";
      const todos = part.tool === "todowrite" && Array.isArray(part.state?.input?.todos) ? `<ul class="todos">${part.state.input.todos.map((t) => `<li class="${esc(t.status)}">${t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"} ${esc(t.content)}</li>`).join("")}</ul>` : "";
      const stateIco = st === "running" || st === "pending" ? '<i class="spin"></i>' : st === "error" ? '<span class="bad">failed</span>' : "";
      const head = `<span class="t-ico">${icon}</span><span class="t-text"><span class="t-name">${esc(label)}</span><span class="t-arg">${esc(toolSummary(part) || "")}</span></span><span class="t-state">${stateIco}</span>`;
      if (!out && !todos) return `<div class="tool ${st}">${head}</div>`;
      const txt = String(out);
      return `<details class="tool ${st}" data-k="${esc(part.id)}"><summary>${head}</summary>${todos}${out ? `<pre class="t-out">${esc(txt.slice(0, 6000))}${txt.length > 6000 ? "\n…" : ""}</pre>` : ""}</details>`;
    }
    case "file":
      return part.mime?.startsWith("image/") && part.url?.startsWith("data:") ? `<img class="att" src="${esc(part.url)}" alt="${esc(part.filename || "image")}">` : `<div class="filechip">📎 ${esc(part.filename || part.url)}</div>`;
    case "patch":
      return `<div class="note">Changed ${part.files?.length || 0} file(s)</div>`;
    case "subtask":
      return `<div class="note">Subtask (${esc(part.agent)}): ${esc(part.description)}</div>`;
    case "retry":
      return `<div class="note warn">Retrying (attempt ${part.attempt})…</div>`;
    case "compaction":
      return `<div class="note">Earlier messages were summarized to save context</div>`;
    default:
      return "";
  }
}

function renderMsg(m) {
  const { info } = m;
  const parts = [...m.parts.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const html = parts.map(renderPart).join("");
  if (info.role === "user") {
    return h(`<div class="msg user" id="m-${esc(info.id)}" data-t="${info.time?.created || 0}">${html}</div>`);
  }
  const done = info.time?.completed;
  const t = info.tokens;
  const hasText = parts.some((p) => p.type === "text" && p.text && !p.synthetic);
  const actions = done
    ? `<div class="actions">${hasText ? `<button data-copy-msg="${esc(info.id)}" aria-label="Copy">${I.copy}</button>` : ""}<span class="meta">${esc(modelInfo({ providerID: info.providerID, modelID: info.modelID })?.model.name || info.modelID || "")} · ${money(info.cost || 0)} · ${compact((t?.input || 0) + (t?.cache?.read || 0))} in / ${compact((t?.output || 0) + (t?.reasoning || 0))} out</span></div>`
    : "";
  const err = info.error ? `<div class="note bad">${esc(info.error.data?.message || info.error.name)}</div>` : "";
  const working = !done && !info.error ? `<div class="working" aria-label="Working"><i></i><i></i><i></i></div>` : "";
  return h(`<div class="msg asst" id="m-${esc(info.id)}" data-t="${info.time?.created || 0}">${html}${working}${err}${actions}</div>`);
}

function renderPerms() {
  const box = $("#perms");
  box.innerHTML = "";
  for (const p of S.perms.values()) {
    if (p.sessionID !== S.current) continue;
    const pat = Array.isArray(p.pattern) ? p.pattern.join(" ") : p.pattern || "";
    const el = h(`<div class="perm"><div><b>Allow ${esc(p.type)}?</b><p>${esc(p.title)}</p>${pat ? `<code>${esc(pat)}</code>` : ""}</div>
      <div class="perm-btns"><button class="btn" data-r="reject">Deny</button><button class="btn" data-r="always">Always</button><button class="btn primary" data-r="once">Allow</button></div></div>`);
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
function isBusy() {
  return ["busy", "retry"].includes(S.status[S.current]?.type);
}
function updateBusy() {
  const busy = isBusy();
  const r = $("#retry");
  const rs = S.status[S.current];
  r.hidden = rs?.type !== "retry";
  if (rs?.type === "retry") {
    const a = rs.action;
    const link = a?.link && /^https?:\/\//.test(a.link) ? ` <a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.label || "Open")}</a>` : "";
    r.innerHTML = `<b>${esc(a?.title || `Retrying (attempt ${rs.attempt})`)}</b><span>${esc(a?.message || rs.message || "")}${link}</span>${rs.next ? `<small class="muted">Next try ${new Date(rs.next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · tap stop to cancel</small>` : ""}`;
  }
  updateSendBtn();
  if (native) {
    native.keepScreenOn(busy && prefs.wakeLock);
    return;
  }
  if (busy && prefs.wakeLock && !wakeLock && navigator.wakeLock) {
    navigator.wakeLock.request("screen").then((l) => {
      wakeLock = l;
      l.addEventListener("release", () => (wakeLock = null));
    }).catch(() => {});
  }
  if (!busy && wakeLock) wakeLock.release().catch(() => {});
}

async function notifyDone(sessionID) {
  if (prefs.notify && native) {
    // The app only shows it while it's in the background.
    const s = S.sessions.find((x) => x.id === sessionID);
    return native.notify("opencode", `${s?.title || "Your chat"} is ready`, sessionID);
  }
  if (!prefs.notify || !document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  const s = S.sessions.find((x) => x.id === sessionID);
  const reg = await navigator.serviceWorker?.getRegistration();
  const opts = { body: `${s?.title || "Your chat"} is ready`, tag: sessionID, icon: "/icons/icon-192.png", badge: "/icons/badge.png", data: { sessionID } };
  if (reg) reg.showNotification("opencode", opts);
  else new Notification("opencode", opts);
}

// ── composer ──────────────────────────────────────────────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;

function updateSendBtn() {
  const b = $("#send-btn");
  const hasInput = $("#prompt").value.trim() || S.attachments.length;
  const mode = rec ? "rec" : hasInput ? "send" : isBusy() ? "stop" : SR || native ? "mic" : "send";
  b.dataset.mode = mode;
  b.innerHTML = { send: I.up, stop: I.stop, mic: I.mic, rec: I.mic }[mode];
  b.setAttribute("aria-label", { send: "Send", stop: "Stop", mic: "Dictate", rec: "Stop dictation" }[mode]);
  b.disabled = mode === "send" && !hasInput;
}

function initComposer() {
  const ta = $("#prompt");
  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.35) + "px";
    updateSendBtn();
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
      if ($("#prompt").value.trim()) send();
    }
  });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const mode = $("#send-btn").dataset.mode;
    if (mode === "send") send();
    else if (mode === "stop") stop();
    else if (mode === "mic" || mode === "rec") dictate();
  });
  $("#attach-btn").addEventListener("click", () => {
    const body = h(`<div class="menu">
      <button class="pick" data-a="camera"><span class="nav-ico">${I.camera}</span><span class="pick-main"><b>Camera</b></span></button>
      <button class="pick" data-a="photos"><span class="nav-ico">${I.image}</span><span class="pick-main"><b>Photos & files</b><small>Images or PDFs</small></span></button></div>`);
    body.addEventListener("click", (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (!a) return;
      closeSheet();
      $(a === "camera" ? "#camera-input" : "#file-input").click();
    });
    openSheet("Add to chat", body);
  });
  for (const id of ["#file-input", "#camera-input"]) {
    $(id).addEventListener("change", async (e) => {
      for (const f of e.target.files) await addAttachment(f);
      e.target.value = "";
    });
  }
}

async function stop() {
  if (!S.current) return;
  buzz(20);
  await oc(`/session/${S.current}/abort`, { method: "POST" }).catch((err) => toast(err.message, "error"));
}

// Voice dictation (Chrome on Android has the Web Speech API).
// The Android app's WebView has no Web Speech API, so it uses Google voice typing instead.
window.__ocpDictation = (text, error) => {
  if (error) return toast(error, "error");
  if (!text) return;
  const ta = $("#prompt");
  ta.value = (ta.value ? ta.value.replace(/\s*$/, " ") : "") + text;
  ta.dispatchEvent(new Event("input"));
};

function dictate() {
  if (native) {
    buzz(15);
    return native.startDictation();
  }
  if (rec) return rec.stop();
  const ta = $("#prompt");
  rec = new SR();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  const base = ta.value ? ta.value.replace(/\s*$/, " ") : "";
  rec.onresult = (ev) => {
    ta.value = base + [...ev.results].map((r) => r[0].transcript).join("");
    ta.dispatchEvent(new Event("input"));
  };
  rec.onend = () => {
    rec = null;
    updateSendBtn();
  };
  rec.onerror = (ev) => ev.error !== "no-speech" && toast(`Microphone: ${ev.error}`, "error");
  buzz(15);
  rec.start();
  updateSendBtn();
}

// Shrink big camera photos before sending them to a model.
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
      if (file.size > 10e6) return toast("That file is too large (10 MB max)", "error");
      url = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
    }
    S.attachments.push({ type: "file", mime, url, filename: file.name || "photo.jpg" });
    renderAttachments();
  } catch (e) {
    toast(`Couldn't add ${file.name}: ${e.message}`, "error");
  }
}
function renderAttachments() {
  const box = $("#attachments");
  box.innerHTML = "";
  S.attachments.forEach((a, i) => {
    const el = h(`<button type="button" class="att-chip" aria-label="Remove ${esc(a.filename)}">${a.mime.startsWith("image/") ? `<img src="${esc(a.url)}" alt="">` : "PDF"}<i>✕</i></button>`);
    el.addEventListener("click", () => {
      S.attachments.splice(i, 1);
      renderAttachments();
    });
    box.append(el);
  });
  updateSendBtn();
}

async function send() {
  const ta = $("#prompt");
  const text = ta.value.trim();
  if (!text && !S.attachments.length) return;
  if (!S.model) {
    toast("Choose a model first", "error");
    return openModelPicker();
  }
  const cmd = text.match(/^\/(\S+)\s*([\s\S]*)$/); // /init, /review, custom commands
  buzz(12);
  const files = S.attachments.splice(0);
  ta.value = "";
  store.set("draft", "");
  ta.dispatchEvent(new Event("input"));
  renderAttachments();
  ta.blur();
  try {
    if (!S.current) {
      const s = await oc("/session", { method: "POST", body: {} });
      if (!S.sessions.some((x) => x.id === s.id)) S.sessions.unshift(s);
      S.current = s.id;
      store.set("session", s.id);
      S.msgs.clear();
      renderChat();
    }
    S.status[S.current] = { type: "busy" };
    updateBusy();
    if (cmd && !files.length) {
      oc(`/session/${S.current}/command`, { method: "POST", body: { command: cmd[1], arguments: cmd[2], agent: S.agent, model: `${S.model.providerID}/${S.model.modelID}` } }).catch((e) => toast(e.message, "error"));
    } else {
      await oc(`/session/${S.current}/prompt_async`, { method: "POST", body: { model: S.model, agent: S.agent, parts: [...(text ? [{ type: "text", text }] : []), ...files] } });
    }
    scrollChat();
  } catch (e) {
    toast(e.message, "error", 6000);
    ta.value = text;
    ta.dispatchEvent(new Event("input"));
    S.status[S.current] = { type: "idle" };
    updateBusy();
  }
}

// Android share sheet → opencode (manifest share_target).
function handleShare() {
  const q = new URLSearchParams(location.search);
  const shared = [q.get("title"), q.get("text"), q.get("url")].filter(Boolean).join("\n");
  if (!shared) return;
  newChat();
  $("#prompt").value = shared;
  $("#prompt").dispatchEvent(new Event("input"));
}

// ── balance page ──────────────────────────────────────────────────────────────────────
let balTimer = 0;
function refreshBalancesSoon() {
  clearTimeout(balTimer);
  balTimer = setTimeout(() => refreshBalances(), 1500);
}
async function refreshBalances(force = false) {
  try {
    S.balances = await api(`/api/balances${force ? "?force=1" : ""}`);
    renderProfile();
    if (!$("#page-balance").hidden) renderBalance();
  } catch (e) {
    if (!$("#page-balance").hidden) $("#balance").innerHTML = `<p class="bad pad">${esc(e.message)}</p>`;
  }
}
$("#bal-refresh").addEventListener("click", () => {
  buzz();
  refreshBalances(true).then(() => toast("Balances updated"));
});

const balUi = { q: "", used: store.get("balUsed", false), open: new Set() };

function bar(used, cap) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  return `<span class="bar ${pct > 90 ? "hot" : pct > 70 ? "warm" : ""}"><i style="width:${pct.toFixed(1)}%"></i></span>`;
}

function renderBalance() {
  const B = S.balances;
  const root = $("#balance");
  if (!B) {
    root.innerHTML = `<p class="muted pad">Loading…</p>`;
    return;
  }
  const usd = B.providers.filter((p) => Number.isFinite(p.balance.amount) && p.balance.currency === "USD");
  const totalLeft = usd.reduce((s, p) => s + p.balance.amount, 0);

  const prov = B.providers
    .map((p) => {
      const b = p.balance;
      const tag = { live: ["Live", "live"], manual: ["Tracked", ""], subscription: ["Plan", ""], none: ["Spend only", ""] }[b.source];
      const amount = b.source === "subscription" ? `<span class="amount">Subscription</span>` : Number.isFinite(b.amount) ? `<span class="amount ${b.amount <= 0 ? "bad" : ""}">${money(b.amount, b.currency)}</span>` : `<span class="amount muted">${b.error ? "Unavailable" : "—"}</span>`;
      const note = b.error ? `Couldn't check: ${b.error}` : b.detail || (b.source === "none" ? "No balance API — enter your balance to track what's left" : "");
      return `<div class="prov">
        <div class="prov-h"><b>${esc(p.name)}</b><span class="tag ${tag[1]}">${tag[0]}</span></div>
        ${amount}
        ${note ? `<small>${esc(note)}</small>` : ""}
        <small>Spent ${money(p.spend?.windows.day || 0)} today · ${money(p.spend?.windows.month || 0)} this month</small>
        ${b.source !== "live" ? `<form class="inline-form" data-set-balance="${esc(p.id)}"><input inputmode="decimal" placeholder="${b.source === "manual" ? "Update balance" : "Current balance"}" aria-label="Balance for ${esc(p.name)}" /><button class="btn">Save</button>${b.source === "manual" ? `<button class="btn ghost" type="button" data-clear-balance="${esc(p.id)}">Clear</button>` : ""}</form>` : ""}
        ${p.id === "opencode" ? `<a class="small" href="https://opencode.ai/console" target="_blank" rel="noopener">Add credits in the OpenCode console</a>` : ""}
      </div>`;
    })
    .join("");

  const q = balUi.q.toLowerCase();
  const models = B.models.filter((m) => (!balUi.used || m.spend) && (!q || `${m.name} ${m.modelID} ${m.providerName}`.toLowerCase().includes(q)));
  const rows = models
    .slice(0, 300)
    .map((m) => {
      const open = balUi.open.has(m.key);
      const left = m.free ? `<b class="ok">Free</b>` : Number.isFinite(m.spendable) ? `<b class="${m.spendable <= 0 ? "bad" : ""}">${money(m.spendable, m.currency)}</b>` : `<b class="muted">—</b>`;
      const sub = m.tokensLeft?.output ? `≈ ${compact(m.tokensLeft.output)} output tokens` : m.free ? "No cost" : m.spend ? `${money(m.spend.windows.month)} this month` : `$${m.cost.input} / $${m.cost.output} per 1M`;
      const lim = m.limits
        ? `<div class="limits">${[["5h", "5 hours"], ["week", "Week"], ["month", "Month"]].map(([w, label]) => `<div class="lim"><span>${label}</span>${bar(m.limits[w].used, m.limits[w].cap)}<span>${money(m.limits[w].used)} / ${money(m.limits[w].cap)}</span></div>`).join("")}</div>`
        : "";
      const detail = open
        ? `<div class="m-detail">
          <div class="kv"><span>Price / 1M</span><span>${m.cost.input ? `$${m.cost.input} in · $${m.cost.output} out` : "Free"}${m.cost.cacheRead ? ` · $${m.cost.cacheRead} cached` : ""}</span></div>
          <div class="kv"><span>Context</span><span>${compact(m.context)} tokens</span></div>
          ${m.tokensLeft?.input ? `<div class="kv"><span>Left</span><span>≈ ${compact(m.tokensLeft.input)} input or ${compact(m.tokensLeft.output)} output tokens</span></div>` : ""}
          <div class="kv"><span>Spent</span><span>${money(m.spend?.windows["5h"] || 0)} 5h · ${money(m.spend?.windows.day || 0)} today · ${money(m.spend?.windows.week || 0)} week · ${money(m.spend?.windows.month || 0)} month</span></div>
          <div class="kv"><span>All time</span><span>${money(m.spend?.cost || 0)} · ${m.spend?.requests || 0} replies · ${compact(m.spend?.input || 0)} in · ${compact(m.spend?.output || 0)} out</span></div>
          <form class="inline-form" data-set-limit="${esc(m.key)}"><input inputmode="decimal" placeholder="Monthly limit ($)" value="${m.limits ? m.limits.month.cap : ""}" aria-label="Monthly limit" /><button class="btn">Set limit</button></form>
          <small class="muted">A monthly limit also caps 5 hours at 20% and a week at 50%, like OpenCode Go.</small>
          <button class="btn" data-use="${esc(m.key)}">Use this model</button>
        </div>`
        : "";
      return `<div class="mrow"><button class="mrow-h" data-toggle="${esc(m.key)}" aria-expanded="${open}">
          <span class="m-name"><b>${esc(m.name)}</b><small>${esc(m.providerName)}${m.status !== "active" ? ` · ${esc(m.status)}` : ""}</small></span>
          <span class="m-left">${left}<small>${sub}</small></span></button>${lim}${detail}</div>`;
    })
    .join("");

  root.innerHTML = `
    <div class="hero"><small>Available across providers</small><span class="big">${usd.length ? money(totalLeft) : "—"}</span><small>${usd.length ? `from ${usd.length} provider${usd.length > 1 ? "s" : ""}` : "Enter a balance below to start tracking"}</small></div>
    <div class="stats"><div class="stat"><small>Today</small><b>${money(B.total.day)}</b></div><div class="stat"><small>30 days</small><b>${money(B.total.month)}</b></div><div class="stat"><small>All time</small><b>${money(B.total.cost)}</b></div></div>
    <div class="section">Providers</div>
    <div class="group">${prov || `<p class="muted pad">No providers connected yet. Add one in Account.</p>`}</div>
    <div class="section">Balance by model</div>
    <div class="filters"><input type="search" id="bal-q" placeholder="Search models" value="${esc(balUi.q)}" aria-label="Search models" /><button class="chip-toggle" id="bal-used" aria-pressed="${balUi.used}">Used</button></div>
    <div class="group">${rows || `<p class="muted pad">No models match</p>`}</div>
    <p class="muted small pad">Live balances come from the provider. Tracked balances are what you entered minus what opencode has spent since. A model's balance is its provider's, capped by any limit you set. Token counts are estimates at list price. Updated ${new Date(B.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>`;
}

$("#balance").addEventListener("click", async (e) => {
  const t = e.target;
  const tg = t.closest("[data-toggle]");
  if (tg) {
    const k = tg.dataset.toggle;
    balUi.open.has(k) ? balUi.open.delete(k) : balUi.open.add(k);
    return renderBalance();
  }
  if (t.id === "bal-used") {
    balUi.used = !balUi.used;
    store.set("balUsed", balUi.used);
    return renderBalance();
  }
  if (t.dataset.use) {
    const [providerID, ...rest] = t.dataset.use.split("/");
    setModel({ providerID, modelID: rest.join("/") });
    toast("Model selected");
    return popLayer();
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
  const raw = $("input", f).value.trim();
  const val = Number(raw.replace(/[$,\s]/g, ""));
  try {
    const b = await api("/api/budgets");
    if (f.dataset.setBalance) {
      if (!raw || !Number.isFinite(val)) throw new Error("Enter an amount, like 25.00");
      b.providers[f.dataset.setBalance] = { balance: val, currency: "USD", asOf: Date.now() };
    } else if (f.dataset.setLimit) {
      if (!raw || val <= 0) delete b.limits[f.dataset.setLimit];
      else b.limits[f.dataset.setLimit] = { monthly: val };
    }
    await api("/api/budgets", { method: "PUT", body: b });
    toast("Saved");
    buzz();
    refreshBalances();
  } catch (err) {
    toast(err.message, "error");
  }
});
$("#balance").addEventListener("input", (e) => {
  if (e.target.id !== "bal-q") return;
  balUi.q = e.target.value;
  clearTimeout(balTimer);
  balTimer = setTimeout(() => {
    renderBalance();
    const q = $("#bal-q");
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
  }, 200);
});

// ── account page ──────────────────────────────────────────────────────────────────────
async function renderAccount() {
  const root = $("#account");
  if (!S.accounts) root.innerHTML = `<p class="muted pad">Loading…</p>`;
  try {
    [S.me, S.accounts] = await Promise.all([api("/api/me"), api("/api/accounts")]);
  } catch (e) {
    root.innerHTML = `<p class="bad pad">${esc(e.message)}</p>`;
    return;
  }
  renderProfile();
  const me = S.me;
  const B = S.balances;
  const accs = S.accounts.accounts
    .map((a) => {
      const how = a.type === "oauth" ? (a.expires && a.expires < Date.now() ? "Signed in · refreshes on next use" : "Signed in with your account") : a.type === "env" ? "Key from an environment variable" : `API key ${a.hint || ""}`;
      return `<div class="row"><span class="dot ${a.connected ? "on" : ""}"></span><span class="row-main"><b>${esc(a.name)}</b><small>${esc(how)}</small></span><button class="btn" data-connect="${esc(a.id)}">${a.connected ? "Manage" : "Connect"}</button></div>`;
    })
    .join("");
  const info = [
    ["Server", me.opencode.url],
    ["Status", me.opencode.reachable ? "Connected" : `Offline (${me.opencode.error || "unknown"})`],
    ["Project", me.opencode.worktree || "—"],
    ["Signed in", new Date(me.user.since).toLocaleDateString()],
    ["Session ends", new Date(me.user.expires).toLocaleDateString()],
    ["App version", `${me.bridge.version}${me.bridge.demo ? " (demo)" : ""}`],
  ];
  root.innerHTML = `
    <div class="profile-card"><span class="avatar big">${esc(me.user.name[0])}</span><h2>${esc(me.user.name)}</h2>
      <small class="muted">${B ? `${money(B.total.month)} spent this month · ${money(B.total.cost)} all time` : ""}</small></div>
    <div class="section"><span>Model providers</span><button class="btn ghost" id="connect-new">Add</button></div>
    <div class="group">${accs || `<p class="muted pad">No providers yet. Tap Add to sign in to OpenCode Zen, Anthropic, OpenAI, GitHub Copilot, OpenRouter and more.</p>`}</div>
    ${me.bridge.authFileFound || me.bridge.demo ? "" : `<p class="muted small pad">Couldn't read ${esc(me.bridge.authFile)}. Live balances and key hints need the bridge on the same computer as opencode (or set OPENCODE_AUTH_FILE).</p>`}
    <div class="section">opencode</div>
    <div class="group">${info.map(([k, v]) => `<div class="row"><span class="row-main"><small>${k}</small><span>${esc(v)}</span></span></div>`).join("")}</div>
    <div class="section">Billing</div>
    <div class="group">
      <button class="row" data-goto="balance"><span class="nav-ico">${I.wallet}</span><span class="row-main"><span>Balance & usage</span></span>${I.right}</button>
      <a class="row" style="text-decoration:none;color:inherit" href="https://opencode.ai/console" target="_blank" rel="noopener"><span class="nav-ico">${I.globe}</span><span class="row-main"><span>OpenCode console</span><small>Credits, invoices, Go plan</small></span>${I.right}</a>
    </div>
    <div class="section"></div>
    <div class="group"><button class="row bad" id="logout"><span class="nav-ico bad">${I.logout}</span><span class="row-main"><span>Log out</span></span></button></div>`;
  $("#connect-new").addEventListener("click", () => connectFlow());
  $$("[data-connect]", root).forEach((b) => b.addEventListener("click", () => connectFlow(b.dataset.connect)));
  $("[data-goto]", root).addEventListener("click", () => {
    popLayer();
    setTimeout(() => openPage("balance"), 220);
  });
  $("#logout").addEventListener("click", async () => {
    if (!confirm("Log out of opencode on this phone?")) return;
    await api("/api/logout", { method: "POST" }).catch(() => {});
    while (layers.length) layers.pop().close(true);
    showLogin();
  });
}

// Sign in to a model provider through opencode (OAuth or API key), from the phone.
function connectFlow(providerID) {
  const avail = S.accounts?.available || [];
  const body = h(`<div><input type="search" placeholder="Search providers" aria-label="Search providers" /><div class="list"></div></div>`);
  const list = $(".list", body);
  const search = $("input", body);
  const choose = (p) => {
    search.hidden = true;
    $("#sheet-label").textContent = `Connect ${p.name}`;
    list.innerHTML = "";
    p.methods.forEach((m, idx) => {
      const b = h(`<button class="pick"><span class="nav-ico">${m.type === "oauth" ? I.user : I.key}</span><span class="pick-main"><b>${esc(m.label)}</b><small>${m.type === "oauth" ? "Sign in on the provider's website" : "Paste an API key"}</small></span>${I.right}</button>`);
      b.addEventListener("click", () => (m.type === "oauth" ? oauth(p, idx) : apiKey(p)));
      list.append(b);
    });
  };
  const apiKey = (p) => {
    list.innerHTML = "";
    const f = h(`<form class="stack" style="padding:4px 8px"><input type="password" autocomplete="off" placeholder="API key" required aria-label="API key" />
      <small class="muted">Sent once to your opencode server and stored there. It isn't kept on this phone.</small><button class="btn accent">Save key</button></form>`);
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
    list.innerHTML = `<p class="pad muted"><i class="spin"></i> Starting sign-in…</p>`;
    try {
      const a = await oc(`/provider/${encodeURIComponent(p.id)}/oauth/authorize`, { method: "POST", body: { method } });
      list.innerHTML = "";
      const f = h(`<form class="stack" style="padding:4px 8px"><a class="btn accent block" href="${esc(a.url)}" target="_blank" rel="noopener">Continue to ${esc(p.name)}</a>
        ${a.instructions ? `<p class="muted small" style="margin:0">${esc(a.instructions)}</p>` : ""}
        ${a.method === "code" ? `<input placeholder="Paste the code here" autocomplete="off" required aria-label="Authorization code" /><button class="btn primary">Finish</button>` : `<p class="muted small"><i class="spin"></i> Waiting for you to finish signing in…</p>`}</form>`);
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
    toast(`${p.name} connected`);
    buzz([10, 40, 10]);
    closeSheet();
    renderAccount();
    loadModels();
    refreshBalances(true);
  };
  const popular = ["opencode", "anthropic", "openai", "github-copilot", "openrouter", "google", "deepseek", "xai", "groq"];
  const draw = (q = "") => {
    list.innerHTML = "";
    q = q.toLowerCase();
    const items = avail.filter((p) => !q || `${p.name} ${p.id}`.toLowerCase().includes(q)).sort((a, b) => (popular.indexOf(a.id) + 1 || 99) - (popular.indexOf(b.id) + 1 || 99) || a.name.localeCompare(b.name));
    for (const p of items.slice(0, 80)) {
      const b = h(`<button class="pick"><span class="pick-main"><b>${esc(p.name)}</b><small>${p.methods.some((m) => m.type === "oauth") ? "Sign in or API key" : "API key"}</small></span>${I.right}</button>`);
      b.addEventListener("click", () => choose(p));
      list.append(b);
    }
    if (!items.length) list.append(h(`<p class="muted pad">No match</p>`));
  };
  search.addEventListener("input", (e) => draw(e.target.value));
  const pre = providerID && avail.find((p) => p.id === providerID);
  openSheet("Add a provider", body);
  pre ? choose(pre) : draw();
}

// ── settings page ─────────────────────────────────────────────────────────────────────
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvt = e;
  if (!$("#page-settings").hidden) renderSettings();
});

function renderSettings() {
  const root = $("#settings");
  const tog = (k, label, hint = "") => `<label class="switch"><span class="row-main"><span>${label}</span>${hint ? `<small>${hint}</small>` : ""}</span><input type="checkbox" data-pref="${k}" ${prefs[k] ? "checked" : ""}/><i></i></label>`;
  const installed = matchMedia("(display-mode: standalone)").matches;
  root.innerHTML = `
    <div class="section">Appearance</div>
    <div class="seg" role="group" aria-label="Appearance">${["system", "light", "dark"].map((m) => `<button data-appearance="${m}" aria-pressed="${prefs.appearance === m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join("")}</div>
    <div class="section"><span>Text size</span><span id="scale-val">${Math.round(prefs.fontScale * 100)}%</span></div>
    <div class="group" style="padding:4px 14px"><input type="range" min="0.85" max="1.3" step="0.05" value="${prefs.fontScale}" id="scale" aria-label="Text size" /></div>
    <div class="section">Chat</div>
    <div class="group">
      ${tog("showReasoning", "Show thinking", "See the model's reasoning steps")}
      ${tog("enterSends", "Enter to send", "Otherwise Enter adds a new line")}
      ${tog("notify", "Notify when done", "When a reply finishes while the app is closed")}
      ${tog("wakeLock", "Keep screen on", "While opencode is working")}
      ${tog("haptics", "Haptic feedback")}
    </div>
    <div class="section">App</div>
    <div class="group">
      ${native ? `<button class="row" id="change-server"><span class="row-main"><span>Server</span><small>${esc(native.getServer())}</small></span><span class="btn">Change</span></button>` : installEvt ?`<button class="row" id="install"><span class="row-main"><span>Install app</span><small>Add opencode to your home screen</small></span>${I.right}</button>` : `<div class="row"><span class="row-main"><span>${installed ? "Installed" : "Install app"}</span><small>${installed ? "Running as an app" : "Chrome menu ⋮ → Add to Home screen"}</small></span></div>`}
      <button class="row" id="reload-oc"><span class="row-main"><span>Reload opencode</span><small>Picks up new sign-ins and config</small></span>${I.right}</button>
      <button class="row" id="clear-cache"><span class="row-main"><span>Clear app cache</span></span>${I.right}</button>
    </div>
    <p class="muted small pad">opencode·pixel ${esc(S.me?.bridge?.version || "")} · with a keyboard: Ctrl+Enter sends</p>`;
}

$("#settings").addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.appearance) {
    prefs.appearance = t.dataset.appearance;
    savePrefs();
    applyAppearance(prefs.appearance);
    buzz();
    renderSettings();
  } else if (t.id === "change-server") {
    native.resetServer();
  } else if (t.id === "install" && installEvt) {
    installEvt.prompt();
    await installEvt.userChoice;
    installEvt = null;
    renderSettings();
  } else if (t.id === "reload-oc") {
    if (!confirm("Reload opencode? Any reply in progress will stop.")) return;
    await oc("/instance/dispose", { method: "POST" }).catch((err) => toast(err.message, "error"));
    setTimeout(loadAll, 800);
    toast("opencode reloaded");
  } else if (t.id === "clear-cache") {
    for (const k of (await caches?.keys?.()) || []) await caches.delete(k);
    (await navigator.serviceWorker?.getRegistration())?.unregister();
    location.reload();
  }
});
$("#settings").addEventListener("change", async (e) => {
  const k = e.target.dataset.pref;
  if (!k) return;
  prefs[k] = e.target.checked;
  if (k === "notify" && prefs.notify && native && !native.canNotify()) {
    window.__ocpNotifyPermission = (ok) => {
      prefs.notify = ok;
      e.target.checked = ok;
      savePrefs();
      if (!ok) toast("Notifications are off for opencode in Android settings", "error");
    };
    native.requestNotifications();
  } else if (k === "notify" && prefs.notify && "Notification" in window && Notification.permission !== "granted") {
    prefs.notify = (await Notification.requestPermission()) === "granted";
    e.target.checked = prefs.notify;
  }
  savePrefs();
  buzz();
  if (k === "showReasoning") renderChat();
});
$("#settings").addEventListener("input", (e) => {
  if (e.target.id !== "scale") return;
  prefs.fontScale = Number(e.target.value);
  document.documentElement.style.setProperty("--scale", prefs.fontScale);
  $("#scale-val").textContent = `${Math.round(prefs.fontScale * 100)}%`;
  savePrefs();
});

// ── service worker ────────────────────────────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open-session" && e.data.sessionID) openSession(e.data.sessionID);
  });
}

boot();
