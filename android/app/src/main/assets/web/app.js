// opencode·pixel — a standalone AI chat app that runs entirely on the phone. It talks to model
// providers directly with your own API keys; chats and token usage are stored on the device.
import { markdown, esc } from "./js/markdown.js";
import { applyAppearance, onSystemAppearanceChange } from "./js/themes.js";
import { I } from "./js/icons.js";
import { endpoint, hostsFor, customProvider, POPULAR, slimCatalog } from "./js/catalog.js";
import { buildRequest, createParser, errorMessage, estimateTokens } from "./js/llm.js";
import { stream, request, saveKey, deleteKey, keyHints, isNative } from "./js/net.js";
import * as db from "./js/db.js";
import { summarize, tokensLeft, fmtTokens, costOf, total } from "./js/tokens.js";

// ── helpers ───────────────────────────────────────────────────────────────────────────
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const native = window.OpencodeAndroid || null;
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
      /* storage unavailable */
    }
  },
};
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const DEFAULT_SYSTEM = "You are a helpful assistant in a phone app. Be clear and concise. Use Markdown when it helps.";
const prefs = {
  appearance: "system",
  fontScale: 1,
  haptics: true,
  notify: false,
  wakeLock: true,
  enterSends: false,
  showReasoning: true,
  name: "",
  system: DEFAULT_SYSTEM,
  ...store.get("prefs", {}),
};
const savePrefs = () => store.set("prefs", prefs);
const buzz = (ms = 8) => prefs.haptics && navigator.vibrate?.(ms);

function ago(t) {
  if (!t) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function toast(text, kind = "info", ms = 3200) {
  const el = h(`<div class="toast ${kind}"></div>`);
  el.textContent = text;
  $("#toasts").append(el);
  el.addEventListener("click", () => el.remove());
  setTimeout(() => el.classList.add("out"), ms);
  setTimeout(() => el.remove(), ms + 300);
}

$$("[data-i]").forEach((el) => (el.innerHTML = I[el.dataset.i] || ""));
$("#menu-btn").innerHTML = I.menu;
$("#new-btn").innerHTML = I.compose;
$("#title-chev").innerHTML = I.down;
$("#attach-btn").innerHTML = I.plus;
$("#jump").innerHTML = I.down;
$("#tok-refresh").innerHTML = I.refresh;
$$(".pagebar .back").forEach((b) => (b.innerHTML = I.back));
$("#drawer-mark").innerHTML = I.mark;

// ── state ─────────────────────────────────────────────────────────────────────────────
const S = {
  catalog: [], // providers from models.dev
  catalogAt: 0,
  custom: [], // user-defined OpenAI-compatible providers
  keys: {}, // { providerId: { hint, hosts } }
  chats: [], // all chats (with messages)
  chat: null, // current chat
  usage: [], // token ledger
  stats: null, // summarize(usage)
  budgets: { providers: {}, models: {} },
  live: {}, // live credit per provider
  model: store.get("model", null), // { providerID, modelID }
  attachments: [],
  streaming: null, // { chatId, abort }
};

applyAppearance(prefs.appearance);
onSystemAppearanceChange(() => applyAppearance(prefs.appearance));
document.documentElement.style.setProperty("--scale", prefs.fontScale);

// Providers you can chat with: ones with a key, plus custom (local) providers.
function connected() {
  const list = S.catalog.filter((p) => S.keys[p.id]);
  return [...list, ...S.custom.map(customProvider)];
}
function findProvider(id) {
  return S.catalog.find((p) => p.id === id) || (S.custom.find((c) => c.id === id) && customProvider(S.custom.find((c) => c.id === id)));
}
function find(m = S.model) {
  if (!m) return null;
  const provider = findProvider(m.providerID);
  const model = provider?.models.find((x) => x.id === m.modelID);
  return provider && model ? { provider, model } : null;
}
function left(provider, model) {
  return tokensLeft({ provider, model, entries: S.usage, budgets: S.budgets, live: S.live, stats: S.stats?.models[`${provider.id}/${model.id}`] });
}

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
const popLayer = () => layers.length && history.back();
window.addEventListener("popstate", () => layers.pop()?.close());
const topLayer = () => layers[layers.length - 1]?.name;

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
    if (!open && (topLayer() || !e.target.closest("#chat") || e.target.closest("pre, .table, .att"))) return;
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
    d.classList.add("dragging");
    d.style.transform = `translateX(${mode === "open" ? Math.min(0, -w + dx) : Math.min(0, dx)}px)`;
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

const PAGES = { tokens: renderTokens, providers: renderProviders, settings: renderSettings };
function openPage(name) {
  const el = $(`#page-${name}`);
  el.hidden = false;
  el.classList.remove("closing");
  pushLayer(`page:${name}`, (instant) => {
    if (instant) return (el.hidden = true);
    el.classList.add("closing");
    setTimeout(() => (el.hidden = true), 190);
  }, { replace: topLayer() === "drawer" });
  PAGES[name]();
  if (name === "tokens") refreshLive().then(() => !$("#page-tokens").hidden && renderTokens());
}
$$("[data-page]").forEach((b) => b.addEventListener("click", () => openPage(b.dataset.page)));
$$(".pagebar .back").forEach((b) => b.addEventListener("click", popLayer));

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

// ── boot ──────────────────────────────────────────────────────────────────────────────
async function loadCatalog() {
  const cached = await db.kv.get("catalog").catch(() => null);
  let bundled = null;
  try {
    bundled = await (await fetch("catalog.json")).json();
  } catch {
    /* missing in dev */
  }
  const best = [cached, bundled].filter(Boolean).sort((a, b) => b.at - a.at)[0];
  S.catalog = best?.providers || [];
  S.catalogAt = best?.at || 0;
}

/** Downloads the latest model list and prices from models.dev. */
async function refreshCatalog({ quiet = false } = {}) {
  try {
    const r = await request({ method: "GET", url: "https://models.dev/api.json", headers: { accept: "application/json" } });
    if (r.status !== 200 || !r.json) throw new Error(`models.dev returned ${r.status}`);
    const slim = slimCatalog(r.json);
    await db.kv.set("catalog", slim);
    S.catalog = slim.providers;
    S.catalogAt = slim.at;
    if (!quiet) toast(`Model list updated · ${slim.providers.reduce((n, p) => n + p.models.length, 0)} models`);
  } catch (e) {
    if (!quiet) toast(`Couldn't update models: ${e.message}`, "error");
  }
}

async function boot() {
  await loadCatalog();
  S.keys = keyHints();
  S.custom = (await db.kv.get("custom")) || [];
  S.budgets = (await db.kv.get("budgets")) || { providers: {}, models: {} };
  S.budgets.providers ||= {};
  S.budgets.models ||= {};
  S.live = (await db.kv.get("live")) || {};
  S.chats = ((await db.chats.all()) || []).sort((a, b) => b.updated - a.updated);
  S.usage = (await db.usage.all()) || [];
  S.stats = summarize(S.usage);
  pickDefaultModel();
  const q = new URLSearchParams(location.search);
  const last = store.get("chat", null);
  if (q.get("chat") && S.chats.some((c) => c.id === q.get("chat"))) openChat(q.get("chat"));
  else if (!q.has("new") && last && S.chats.some((c) => c.id === last)) openChat(last);
  else newChat(false);
  if (q.get("text")) {
    newChat(false);
    $("#prompt").value = q.get("text");
    $("#prompt").dispatchEvent(new Event("input"));
  }
  if (PAGES[q.get("page")]) openPage(q.get("page"));
  if (location.search) history.replaceState(null, "", location.pathname);
  renderProfile();
  // Keep prices and models fresh (weekly) and balances current, quietly.
  if (Date.now() - S.catalogAt > 7 * 86400_000) refreshCatalog({ quiet: true });
  refreshLive();
}

function pickDefaultModel() {
  if (find(S.model)) return;
  const conn = connected();
  const p = conn.find((x) => x.id === "opencode") || conn[0];
  const m = p?.models.find((x) => !x.st) || p?.models[0];
  S.model = m ? { providerID: p.id, modelID: m.id } : null;
}

function renderProfile() {
  const name = prefs.name || "You";
  $("#avatar").textContent = name[0];
  $("#profile-name").textContent = name;
  const conn = connected();
  $("#profile-sub").textContent = `${fmtTokens(S.stats?.all.w.day || 0)} tokens today`;
  $("#nav-tokens").textContent = fmtTokens(S.stats?.all.w.month || 0);
  $("#nav-providers").textContent = conn.length ? String(conn.length) : "";
  renderComposerBar();
}

// ── models ────────────────────────────────────────────────────────────────────────────
function setModel(m) {
  S.model = m;
  store.set("model", m);
  if (S.chat && !S.chat.messages.length) S.chat.model = m;
  renderComposerBar();
}

function leftLabel(provider, model) {
  const l = left(provider, model);
  if (l.tokens === Infinity) return `<span class="ok">Free</span>`;
  if (l.tokens === null) return "";
  return `<span class="${l.tokens <= 0 ? "bad" : ""}">${fmtTokens(l.tokens)} left</span>`;
}

function renderComposerBar() {
  const f = find();
  $("#model-chip").innerHTML = `<span>${esc(f ? f.model.name : connected().length ? "Choose model" : "Add a provider")}</span>${I.down}`;
  updateSendBtn();
}

function openModelPicker() {
  const conn = connected();
  if (!conn.length) return addProviderFlow();
  const body = h(`<div><input type="search" placeholder="Search models" aria-label="Search models" /><div class="list"></div></div>`);
  const list = $(".list", body);
  const draw = (q = "") => {
    q = q.toLowerCase();
    list.innerHTML = "";
    for (const p of conn) {
      let models = p.models.filter((m) => !q || `${p.name} ${m.name} ${m.id}`.toLowerCase().includes(q));
      // Models you've used come first.
      models = models.sort((a, b) => (S.stats?.models[`${p.id}/${b.id}`]?.last || 0) - (S.stats?.models[`${p.id}/${a.id}`]?.last || 0));
      if (!models.length) continue;
      list.append(h(`<div class="group-h">${esc(p.name)}</div>`));
      const shown = models.slice(0, q ? 200 : 40);
      for (const m of shown) {
        const sel = S.model?.providerID === p.id && S.model?.modelID === m.id;
        const feats = [m.ctx && `${fmtTokens(m.ctx)} context`, m.r && "thinking", m.img && "images", m.st].filter(Boolean).join(" · ");
        const row = h(`<button class="pick ${sel ? "sel" : ""}"><span class="pick-check">${sel ? I.check : ""}</span>
          <span class="pick-main"><b>${esc(m.name)}</b><small>${esc(feats)}</small></span><span class="pick-side">${leftLabel(p, m)}</span></button>`);
        row.addEventListener("click", () => {
          setModel({ providerID: p.id, modelID: m.id });
          buzz();
          closeSheet();
        });
        list.append(row);
      }
      if (models.length > shown.length) list.append(h(`<p class="muted small pad">${models.length - shown.length} more — search to find them</p>`));
    }
    if (!list.children.length) list.append(h(`<p class="muted pad">No models match</p>`));
  };
  draw();
  $("input", body).addEventListener("input", (e) => draw(e.target.value));
  openSheet("Choose a model", body);
  setTimeout(() => $(".pick.sel", body)?.scrollIntoView({ block: "center" }), 60);
}
$("#model-chip").addEventListener("click", openModelPicker);

// ── chats ─────────────────────────────────────────────────────────────────────────────
function renderRecents() {
  const ul = $("#recents");
  const q = $("#chat-filter").value.toLowerCase();
  ul.innerHTML = "";
  const rows = S.chats.filter((c) => c.messages.length && (!q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.text?.toLowerCase().includes(q))));
  for (const c of rows) {
    const busy = S.streaming?.chatId === c.id;
    const li = h(`<li class="recent ${c.id === S.chat?.id ? "sel" : ""}"><button class="recent-main">${busy ? '<i class="spin"></i>' : ""}<span>${esc(c.title)}</span></button><button class="icon-btn" aria-label="Options for ${esc(c.title)}">${I.more}</button></li>`);
    const main = li.querySelector(".recent-main");
    main.addEventListener("click", () => {
      popLayer();
      openChat(c.id);
    });
    let lp;
    main.addEventListener("touchstart", () => (lp = setTimeout(() => (buzz(20), chatMenu(c)), 550)), { passive: true });
    main.addEventListener("touchend", () => clearTimeout(lp));
    main.addEventListener("touchmove", () => clearTimeout(lp), { passive: true });
    li.querySelector(".icon-btn").addEventListener("click", () => chatMenu(c));
    ul.append(li);
  }
  if (!rows.length) ul.append(h(`<li class="empty">${q ? "No matching chats" : "Your chats will show up here"}</li>`));
}
$("#chat-filter").addEventListener("input", renderRecents);
$("#nav-new").addEventListener("click", () => {
  popLayer();
  newChat();
});
$("#new-btn").addEventListener("click", () => {
  buzz();
  newChat();
});
$("#title-btn").addEventListener("click", () => (S.chat?.messages.length ? chatMenu(S.chat) : openModelPicker()));

function chatToText(c) {
  return c.messages.map((m) => `${m.role === "user" ? "You" : find(m.model)?.model.name || "Assistant"}:\n${m.text || ""}`).join("\n\n");
}

function chatMenu(c) {
  const body = h(`<div class="menu">
    <form class="stack" style="padding:0 8px 8px"><input value="${esc(c.title)}" maxlength="120" aria-label="Chat title" /><button class="btn">Rename</button></form>
    <button class="pick" data-a="share"><span class="nav-ico">${I.share}</span><span class="pick-main"><b>Share as text</b></span></button>
    <button class="pick danger" data-a="delete"><span class="nav-ico">${I.trash}</span><span class="pick-main"><b>Delete</b></span></button></div>`);
  $("form", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    c.title = $("input", body).value.trim() || c.title;
    await db.chats.put(c);
    toast("Renamed");
    closeSheet();
    renderTitle();
    if (topLayer() === "drawer") renderRecents();
  });
  body.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (!a) return;
    if (a === "share") {
      const text = `${c.title}\n\n${chatToText(c)}`;
      if (native) native.share(c.title, text);
      else if (navigator.share) navigator.share({ title: c.title, text }).catch(() => {});
      else navigator.clipboard?.writeText(text).then(() => toast("Copied"));
    }
    if (a === "delete") {
      if (!confirm(`Delete “${c.title}”?`)) return;
      if (S.streaming?.chatId === c.id) S.streaming.abort();
      await db.chats.delete(c.id);
      S.chats = S.chats.filter((x) => x.id !== c.id);
      if (S.chat?.id === c.id) newChat(false);
      toast("Chat deleted");
    }
    closeSheet();
    if (topLayer() === "drawer") renderRecents();
  });
  openSheet(c.title, body);
}

function newChat(focus = true) {
  S.chat = { id: uid(), title: "New chat", created: Date.now(), updated: Date.now(), model: S.model, messages: [] };
  store.set("chat", null);
  renderChat();
  if (focus) $("#prompt").focus();
}

function openChat(id) {
  const c = S.chats.find((x) => x.id === id);
  if (!c) return newChat(false);
  S.chat = c;
  store.set("chat", id);
  const lastModel = [...c.messages].reverse().find((m) => m.model)?.model;
  if (lastModel && find(lastModel)) setModel(lastModel);
  renderChat();
  scrollChat(false);
}

async function saveChat(c) {
  c.updated = Date.now();
  await db.chats.put(c);
  if (!S.chats.includes(c)) S.chats.unshift(c);
  S.chats.sort((a, b) => b.updated - a.updated);
  store.set("chat", c.id);
}

// ── chat rendering ────────────────────────────────────────────────────────────────────
function renderTitle() {
  $("#chat-title").textContent = S.chat?.messages.length ? S.chat.title : "New chat";
  $("#title-chev").hidden = !S.chat?.messages.length;
}

function greeting() {
  const hr = new Date().getHours();
  const part = hr < 5 ? "Hello, night owl" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  return prefs.name ? `${part}, ${prefs.name}` : part;
}

const SUGGESTIONS = ["Explain something simply", "Help me write a message", "Brainstorm ideas", "Review my code"];

function renderChat() {
  renderTitle();
  const log = $("#chat-log");
  log.innerHTML = "";
  if (!S.chat.messages.length) {
    const has = connected().length;
    const el = h(`<div class="greeting">${I.mark}<h2>${esc(greeting())}</h2>
      ${has ? `<p>${esc(find()?.model.name || "Pick a model below")}</p><div class="suggest">${SUGGESTIONS.map((s) => `<button type="button">${esc(s)}</button>`).join("")}</div>`
        : `<p>Add an API key for a model provider to start chatting. It's stored encrypted on this phone.</p><button type="button" class="btn accent" id="cta-add">Add a provider</button>`}</div>`);
    $$(".suggest button", el).forEach((b) => b.addEventListener("click", () => {
      $("#prompt").value = b.textContent;
      $("#prompt").dispatchEvent(new Event("input"));
      $("#prompt").focus();
    }));
    $("#cta-add", el)?.addEventListener("click", () => addProviderFlow());
    log.append(el);
  }
  S.chat.messages.forEach((m, i) => log.append(renderMsg(m, i)));
  updateSendBtn();
}

function renderMsg(m, i) {
  if (m.role === "user") {
    return h(`<div class="msg user" data-i="${i}">${(m.images || []).map((u) => `<img class="att" src="${esc(u)}" alt="Attached image">`).join("")}${m.text ? `<div class="md">${markdown(m.text)}</div>` : ""}</div>`);
  }
  const f = find(m.model);
  const isLast = i === S.chat.messages.length - 1;
  const streaming = !m.done;
  const reasoning = prefs.showReasoning && m.reasoning?.trim()
    ? `<details class="reasoning" ${streaming && !m.text ? "open" : ""}><summary>${m.thinkingMs ? `Thought for ${Math.max(1, Math.round(m.thinkingMs / 1000))}s` : "Thinking…"}</summary><div class="md">${markdown(m.reasoning)}</div></details>`
    : "";
  const body = m.text ? `<div class="md">${markdown(m.text)}</div>` : "";
  const working = streaming && !m.text ? `<div class="working" aria-label="Working"><i></i><i></i><i></i></div>` : "";
  const err = m.error ? `<div class="note bad">${esc(m.error)}</div>` : "";
  const u = m.usage;
  const actions = m.done
    ? `<div class="actions">${m.text ? `<button data-copy-msg="${i}" aria-label="Copy">${I.copy}</button>` : ""}${isLast ? `<button data-retry="${i}" aria-label="Retry">${I.retry}</button>` : ""}<span class="meta">${esc(f?.model.name || m.model?.modelID || "")}${u ? ` · ${fmtTokens(total(u))} tokens${m.est ? " (est.)" : ""}` : ""}</span></div>`
    : "";
  return h(`<div class="msg asst" data-i="${i}">${reasoning}${body}${working}${err}${actions}</div>`);
}

let raf = 0;
function queueRender() {
  if (!raf) raf = requestAnimationFrame(flushRender);
}
function flushRender() {
  raf = 0;
  if (!S.chat) return;
  const log = $("#chat-log");
  const stick = nearBottom();
  const i = S.chat.messages.length - 1;
  const old = $(`.msg[data-i="${i}"]`, log);
  const el = renderMsg(S.chat.messages[i], i);
  const wasOpen = old?.querySelector("details.reasoning")?.open;
  if (wasOpen !== undefined && el.querySelector("details.reasoning")) el.querySelector("details.reasoning").open = wasOpen;
  if (old) old.replaceWith(el);
  else log.append(el);
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
    return copyText(S.chat.messages[Number(c.dataset.copyMsg)]?.text || "", () => {
      c.innerHTML = I.check;
      setTimeout(() => (c.innerHTML = I.copy), 1200);
    });
  }
  const r = e.target.closest("[data-retry]");
  if (r && !S.streaming) {
    S.chat.messages.pop();
    renderChat();
    generate();
  }
});
function copyText(text, done) {
  navigator.clipboard?.writeText(text).then(() => {
    buzz();
    done?.();
  });
}

// ── sending & streaming ───────────────────────────────────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;

function updateSendBtn() {
  const b = $("#send-btn");
  const hasInput = $("#prompt").value.trim() || S.attachments.length;
  const busy = S.streaming?.chatId === S.chat?.id;
  const mode = rec ? "rec" : hasInput && !busy ? "send" : busy ? "stop" : SR || native ? "mic" : "send";
  b.dataset.mode = mode;
  b.innerHTML = { send: I.up, stop: I.stop, mic: I.mic, rec: I.mic }[mode];
  b.setAttribute("aria-label", { send: "Send", stop: "Stop", mic: "Dictate", rec: "Stop dictation" }[mode]);
  b.disabled = mode === "send" && !hasInput;
}

(function initComposer() {
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
      if ($("#send-btn").dataset.mode === "send") send();
    }
  });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const mode = $("#send-btn").dataset.mode;
    if (mode === "send") send();
    else if (mode === "stop") S.streaming?.abort();
    else dictate();
  });
  $("#attach-btn").addEventListener("click", () => {
    const body = h(`<div class="menu">
      <button class="pick" data-a="camera"><span class="nav-ico">${I.camera}</span><span class="pick-main"><b>Camera</b></span></button>
      <button class="pick" data-a="photos"><span class="nav-ico">${I.image}</span><span class="pick-main"><b>Photos</b><small>For models that can see images</small></span></button></div>`);
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
})();

// Shrink big camera photos before sending them (saves tokens and upload time).
async function addAttachment(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    S.attachments.push(c.toDataURL("image/jpeg", 0.85));
    renderAttachments();
  } catch (e) {
    toast(`Couldn't add ${file.name}: ${e.message}`, "error");
  }
}
function renderAttachments() {
  const box = $("#attachments");
  box.innerHTML = "";
  S.attachments.forEach((url, i) => {
    const el = h(`<button type="button" class="att-chip" aria-label="Remove image"><img src="${esc(url)}" alt=""><i>✕</i></button>`);
    el.addEventListener("click", () => {
      S.attachments.splice(i, 1);
      renderAttachments();
    });
    box.append(el);
  });
  updateSendBtn();
}

// Voice: Google voice typing in the Android app, the Web Speech API in a browser.
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
  if (!SR) return;
  if (rec) return rec.stop();
  rec = new SR();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = false;
  rec.onresult = (ev) => window.__ocpDictation([...ev.results].map((r) => r[0].transcript).join(""));
  rec.onend = () => {
    rec = null;
    updateSendBtn();
  };
  rec.start();
  updateSendBtn();
}

async function send() {
  const ta = $("#prompt");
  const text = ta.value.trim();
  if (!text && !S.attachments.length) return;
  const f = find();
  if (!f) {
    toast(connected().length ? "Choose a model first" : "Add a provider first", "error");
    return connected().length ? openModelPicker() : addProviderFlow();
  }
  if (S.attachments.length && !f.model.img) toast(`${f.model.name} may not accept images`, "info");
  buzz(12);
  const msg = { role: "user", text, images: S.attachments.splice(0), time: Date.now() };
  ta.value = "";
  store.set("draft", "");
  ta.dispatchEvent(new Event("input"));
  renderAttachments();
  ta.blur();
  const c = S.chat;
  if (!c.messages.length) c.title = (text || "Image").replace(/\s+/g, " ").slice(0, 48);
  c.messages.push(msg);
  await saveChat(c);
  renderChat();
  generate();
}

/** Streams the assistant's reply to the current chat. */
async function generate() {
  const c = S.chat;
  const f = find();
  if (!f) return;
  const { provider, model } = f;
  const ep = endpoint(provider, model);
  const history = c.messages.filter((m) => m.role === "user" || (m.done && !m.error && m.text)).map((m) => ({ role: m.role, text: m.text, images: m.images }));
  const reply = { role: "assistant", text: "", reasoning: "", model: { providerID: provider.id, modelID: model.id }, time: Date.now(), done: false };
  c.messages.push(reply);
  renderChat();
  scrollChat(false);

  const { headers, body } = buildRequest(ep.style, model, history, { system: prefs.system });
  const parser = createParser(ep.style);
  let status = 0;
  let errText = "";
  let thinkStart = 0;
  const apply = (events) => {
    for (const ev of events) {
      if (ev.type === "text") {
        if (thinkStart && !reply.thinkingMs) reply.thinkingMs = Date.now() - thinkStart;
        reply.text += ev.delta;
      } else if (ev.type === "reasoning") {
        thinkStart ||= Date.now();
        reply.reasoning += ev.delta;
      } else if (ev.type === "error") reply.error = ev.message;
    }
    queueRender();
  };

  const finish = async (error) => {
    if (S.streaming?.chatId === c.id) S.streaming = null;
    apply(parser.end());
    reply.done = true;
    if (error) reply.error = error;
    if (thinkStart && !reply.thinkingMs) reply.thinkingMs = Date.now() - thinkStart;
    let usage = parser.usage();
    if (!usage && (reply.text || reply.reasoning)) {
      // The provider didn't report usage: estimate it so balances still move.
      const inT = estimateTokens(prefs.system + history.map((m) => m.text).join(" ")) + history.reduce((n, m) => n + (m.images?.length || 0) * 1000, 0);
      usage = { input: inT, output: estimateTokens(reply.text + reply.reasoning), reasoning: 0, cacheRead: 0, cacheWrite: 0 };
      reply.est = true;
    }
    if (usage) {
      reply.usage = usage;
      const entry = { time: Date.now(), providerID: provider.id, modelID: model.id, ...usage, cost: costOf(model, usage), est: Boolean(reply.est) };
      S.usage.push(entry);
      S.stats = summarize(S.usage);
      db.usage.add(entry).catch(() => {});
    }
    await saveChat(c);
    if (S.chat === c) {
      flushRender();
      updateSendBtn();
    }
    renderProfile();
    if (native) native.keepScreenOn(false);
    if (!reply.error && prefs.notify && (document.hidden || native)) notifyDone(c);
    if (provider.id in S.live) refreshLive([provider.id]);
  };

  const abort = stream(
    { method: "POST", url: ep.url, headers, body, auth: { provider: provider.id, style: provider.custom && !S.keys[provider.id] ? "none" : ep.auth } },
    {
      onHead: (s) => (status = s),
      onChunk: (t) => {
        if (status >= 400) errText += t;
        else apply(parser.push(t));
      },
      onEnd: () => finish(status >= 400 ? errorMessage(status, errText) : !reply.text && !reply.error && !reply.reasoning ? "The model returned an empty reply." : null),
      onError: (e) => finish(e.aborted || e.message === "Stopped" ? (reply.text ? null : "Stopped") : e.message),
    },
  );
  S.streaming = { chatId: c.id, abort };
  updateSendBtn();
  if (native && prefs.wakeLock) native.keepScreenOn(true);
}

function notifyDone(c) {
  const body = `${c.title} — reply ready`;
  if (native) return native.notify("opencode", body, c.id);
  if ("Notification" in window && Notification.permission === "granted") new Notification("opencode", { body, tag: c.id });
}

// ── live credit from providers that have a balance API ────────────────────────────────
const LIVE = {
  openrouter: { url: "https://openrouter.ai/api/v1/credits", read: (j) => ({ credit: j.data.total_credits - j.data.total_usage }) },
  deepseek: {
    url: "https://api.deepseek.com/user/balance",
    read: (j) => {
      const usd = j.balance_infos?.find((b) => b.currency === "USD");
      const cny = j.balance_infos?.find((b) => b.currency === "CNY");
      if (usd) return { credit: Number(usd.total_balance) };
      if (cny) return { credit: Number(cny.total_balance) / 7.1, approx: true };
      throw new Error("no balance");
    },
  },
  moonshotai: { url: "https://api.moonshot.ai/v1/users/me/balance", read: (j) => ({ credit: Number(j.data.available_balance) }) },
};

async function refreshLive(ids) {
  const targets = (ids || Object.keys(LIVE)).filter((id) => LIVE[id] && S.keys[id]);
  await Promise.all(
    targets.map(async (id) => {
      try {
        const r = await request({ method: "GET", url: LIVE[id].url, headers: { accept: "application/json" }, auth: { provider: id, style: "bearer" } });
        if (r.status !== 200 || !r.json) throw new Error(errorMessage(r.status, r.text));
        S.live[id] = { ...LIVE[id].read(r.json), at: Date.now() };
      } catch (e) {
        S.live[id] = { ...(S.live[id] || {}), error: e.message, at: Date.now() };
      }
    }),
  );
  for (const id of Object.keys(S.live)) if (!S.keys[id]) delete S.live[id];
  db.kv.set("live", S.live).catch(() => {});
}

// ── tokens page ───────────────────────────────────────────────────────────────────────
const tokUi = { q: "", used: store.get("tokUsed", true), open: new Set() };
const PERIOD = { once: "in total", day: "per day", week: "per week", month: "per month" };

function bar(used, cap) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  return `<span class="bar ${pct > 90 ? "hot" : pct > 70 ? "warm" : ""}"><i style="width:${pct.toFixed(1)}%"></i></span>`;
}

/** The model a provider's headline number is shown for: the one you use most. */
function headlineModel(p) {
  const used = p.models.filter((m) => S.stats?.models[`${p.id}/${m.id}`]).sort((a, b) => S.stats.models[`${p.id}/${b.id}`].tokens - S.stats.models[`${p.id}/${a.id}`].tokens);
  if (used[0]) return used[0];
  if (S.model?.providerID === p.id) return p.models.find((m) => m.id === S.model.modelID);
  return p.models.find((m) => m.in || m.out) || p.models[0];
}

function renderTokens() {
  const root = $("#tokens");
  const st = S.stats || summarize([]);
  const conn = connected();

  const provCards = conn
    .map((p) => {
      const pb = S.budgets.providers[p.id];
      const lv = S.live[p.id];
      const m = headlineModel(p);
      const l = m ? left(p, m) : { tokens: null, source: "none" };
      const tag = lv && Number.isFinite(lv.credit) ? ["Live", "live"] : pb?.type === "credit" ? ["Your credit", ""] : pb?.type === "tokens" ? [`Allowance ${PERIOD[pb.period]}`, ""] : ["Not set", ""];
      const big = l.tokens === Infinity ? "Free" : l.tokens === null ? "—" : fmtTokens(l.tokens);
      const note = l.tokens === null
        ? lv?.error ? `Couldn't check balance: ${lv.error}` : "Set your credit or a token allowance to see what's left"
        : l.tokens === Infinity ? "These models cost nothing"
          : `tokens on ${m.name}${l.source === "allowance" ? "" : " · other models vary"}${lv?.approx ? " · approx." : ""}`;
      const used = st.providers[p.id];
      const form = lv && Number.isFinite(lv.credit) ? "" : `
        <form class="budget-form" data-budget="${esc(p.id)}">
          <div class="seg small" role="group"><button type="button" data-type="credit" aria-pressed="${pb?.type !== "tokens"}">Credit</button><button type="button" data-type="tokens" aria-pressed="${pb?.type === "tokens"}">Tokens</button></div>
          <div class="inline-form">
            <input inputmode="decimal" name="amount" placeholder="${pb?.type === "tokens" ? "e.g. 5M" : "Credit from your console"}" aria-label="Amount" />
            <select name="period" aria-label="Resets" ${pb?.type === "tokens" ? "" : "hidden"}>${Object.entries(PERIOD).map(([k, v]) => `<option value="${k}" ${pb?.period === k ? "selected" : ""}>${v}</option>`).join("")}</select>
            <button class="btn">Save</button>${pb ? `<button class="btn ghost" type="button" data-clear="${esc(p.id)}">Clear</button>` : ""}
          </div>
          <small class="muted">${pb?.type === "tokens" ? "A token allowance counts every token you use with this provider." : "Enter your credit as shown in the provider's console. It's converted to tokens at each model's price."}</small>
        </form>`;
      return `<div class="prov">
        <div class="prov-h"><b>${esc(p.name)}</b><span class="tag ${tag[1]}">${esc(tag[0])}</span></div>
        <span class="amount ${l.tokens !== null && l.tokens !== Infinity && l.tokens <= 0 ? "bad" : ""}">${big}</span>
        <small>${esc(note)}</small>
        <small>Used ${fmtTokens(used?.w.day || 0)} today · ${fmtTokens(used?.w.month || 0)} in 30 days</small>
        ${form}
      </div>`;
    })
    .join("");

  const q = tokUi.q.toLowerCase();
  const rows = [];
  for (const p of conn) {
    for (const m of p.models) {
      const key = `${p.id}/${m.id}`;
      const ms = st.models[key];
      if (tokUi.used && !ms && !S.budgets.models[key]) continue;
      if (q && !`${m.name} ${m.id} ${p.name}`.toLowerCase().includes(q)) continue;
      rows.push({ p, m, key, ms });
    }
  }
  rows.sort((a, b) => (b.ms?.last || 0) - (a.ms?.last || 0));
  const modelRows = rows
    .slice(0, 200)
    .map(({ p, m, key, ms }) => {
      const l = left(p, m);
      const open = tokUi.open.has(key);
      const big = l.tokens === Infinity ? `<b class="ok">Free</b>` : l.tokens === null ? `<b class="muted">—</b>` : `<b class="${l.tokens <= 0 ? "bad" : ""}">${fmtTokens(l.tokens)}</b>`;
      const lim = S.budgets.models[key];
      const limLeft = lim ? tokensLeft({ provider: p, model: m, entries: S.usage, budgets: { providers: {}, models: { [key]: lim } }, live: {} }).tokens : 0;
      const limBar = lim ? `<div class="limits"><div class="lim"><span>Limit</span>${bar(lim.amount - limLeft, lim.amount)}<span>${fmtTokens(lim.amount - limLeft)} / ${fmtTokens(lim.amount)} ${PERIOD[lim.period]}</span></div></div>` : "";
      const detail = open ? `<div class="m-detail">
          <div class="kv"><span>Context</span><span>${m.ctx ? `${fmtTokens(m.ctx)} tokens` : "—"}</span></div>
          <div class="kv"><span>Used</span><span>${fmtTokens(ms?.w["5h"] || 0)} 5h · ${fmtTokens(ms?.w.day || 0)} today · ${fmtTokens(ms?.w.week || 0)} week · ${fmtTokens(ms?.w.month || 0)} month</span></div>
          <div class="kv"><span>All time</span><span>${fmtTokens(ms?.tokens || 0)} tokens · ${ms?.replies || 0} replies (${fmtTokens(ms?.input || 0)} in · ${fmtTokens(ms?.output || 0)} out · ${fmtTokens(ms?.cacheRead || 0)} cached)</span></div>
          <form class="inline-form" data-limit="${esc(key)}"><input name="amount" inputmode="decimal" placeholder="Token limit, e.g. 2M" value="${lim ? fmtTokens(lim.amount) : ""}" aria-label="Token limit" />
            <select name="period" aria-label="Resets">${["day", "week", "month", "once"].map((k) => `<option value="${k}" ${lim?.period === k ? "selected" : ""}>${PERIOD[k]}</option>`).join("")}</select><button class="btn">Set</button></form>
          <button class="btn" data-use="${esc(key)}">Use this model</button>
        </div>` : "";
      return `<div class="mrow"><button class="mrow-h" data-toggle="${esc(key)}" aria-expanded="${open}">
          <span class="m-name"><b>${esc(m.name)}</b><small>${esc(p.name)}</small></span>
          <span class="m-left">${big}<small>${l.tokens === null || l.tokens === Infinity ? (ms ? `${fmtTokens(ms.w.month)} used` : "") : "tokens left"}</small></span></button>${limBar}${detail}</div>`;
    })
    .join("");

  root.innerHTML = `
    <div class="hero"><small>Tokens used today</small><span class="big">${fmtTokens(st.all.w.day)}</span><small>${fmtTokens(st.all.replies ? st.all.tokens : 0)} all time · ${st.all.replies} ${st.all.replies === 1 ? "reply" : "replies"}</small></div>
    <div class="stats"><div class="stat"><small>5 hours</small><b>${fmtTokens(st.all.w["5h"])}</b></div><div class="stat"><small>7 days</small><b>${fmtTokens(st.all.w.week)}</b></div><div class="stat"><small>30 days</small><b>${fmtTokens(st.all.w.month)}</b></div></div>
    <div class="section">Balance by provider</div>
    <div class="group">${provCards || `<p class="muted pad">No providers yet. <button class="btn ghost" data-goto="providers">Add one</button></p>`}</div>
    <div class="section">Tokens left by model</div>
    <div class="filters"><input type="search" id="tok-q" placeholder="Search models" value="${esc(tokUi.q)}" aria-label="Search models" /><button class="chip-toggle" id="tok-used" aria-pressed="${tokUi.used}">Used</button></div>
    <div class="group">${modelRows || `<p class="muted pad">${tokUi.used ? "Models you use will show up here. Turn off “Used” to see all." : "No models match"}</p>`}</div>
    <p class="muted small pad">Usage comes from the token counts each provider reports (estimated when it doesn't). Credit is converted to tokens at list price, weighted by how much you send versus receive on each model.</p>`;
}

function parseTokens(s) {
  const m = String(s).trim().toLowerCase().replace(/[, _]/g, "").match(/^(\d+(?:\.\d+)?)([kmb]?)$/);
  if (!m) return NaN;
  return Number(m[1]) * { "": 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]];
}

async function saveBudgets() {
  await db.kv.set("budgets", S.budgets);
  renderTokens();
  renderComposerBar();
}

$("#tok-refresh").addEventListener("click", async () => {
  buzz();
  await refreshLive();
  renderTokens();
  toast("Balances updated");
});
$("#tokens").addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.toggle) {
    tokUi.open.has(t.dataset.toggle) ? tokUi.open.delete(t.dataset.toggle) : tokUi.open.add(t.dataset.toggle);
    return renderTokens();
  }
  if (t.id === "tok-used") {
    tokUi.used = !tokUi.used;
    store.set("tokUsed", tokUi.used);
    return renderTokens();
  }
  if (t.dataset.type) {
    const form = t.closest("form");
    $$("[data-type]", form).forEach((b) => b.setAttribute("aria-pressed", String(b === t)));
    $("select", form).hidden = t.dataset.type !== "tokens";
    $("input", form).placeholder = t.dataset.type === "tokens" ? "e.g. 5M" : "Credit from your console";
    return;
  }
  if (t.dataset.clear) {
    delete S.budgets.providers[t.dataset.clear];
    return saveBudgets();
  }
  if (t.dataset.use) {
    const [providerID, ...rest] = t.dataset.use.split("/");
    setModel({ providerID, modelID: rest.join("/") });
    toast("Model selected");
    return popLayer();
  }
  if (t.dataset.goto) {
    popLayer();
    setTimeout(() => openPage(t.dataset.goto), 220);
  }
});
$("#tokens").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const raw = f.amount.value;
  if (f.dataset.budget) {
    const type = $("[data-type][aria-pressed=true]", f)?.dataset.type || "credit";
    const amount = type === "tokens" ? parseTokens(raw) : Number(String(raw).replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(amount) || amount < 0) return toast(type === "tokens" ? "Enter tokens, like 5M or 250K" : "Enter your credit, like 25.00", "error");
    S.budgets.providers[f.dataset.budget] = type === "tokens" ? { type, amount, period: f.period.value, asOf: Date.now() } : { type, amount, asOf: Date.now() };
  } else if (f.dataset.limit) {
    const amount = parseTokens(raw);
    if (!raw.trim()) delete S.budgets.models[f.dataset.limit];
    else if (!Number.isFinite(amount) || amount <= 0) return toast("Enter tokens, like 2M", "error");
    else S.budgets.models[f.dataset.limit] = { amount, period: f.period.value, asOf: Date.now() };
  }
  buzz();
  toast("Saved");
  saveBudgets();
});
$("#tokens").addEventListener("input", (e) => {
  if (e.target.id !== "tok-q") return;
  tokUi.q = e.target.value;
  clearTimeout(tokUi.timer);
  tokUi.timer = setTimeout(() => {
    renderTokens();
    const q = $("#tok-q");
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
  }, 200);
});

// ── providers page ────────────────────────────────────────────────────────────────────
function renderProviders() {
  S.keys = keyHints();
  const root = $("#providers");
  const conn = connected();
  const rows = conn
    .map((p) => `<div class="row"><span class="dot on"></span><span class="row-main"><b>${esc(p.name)}</b><small>${p.custom ? esc(p.api) : `API key ${esc(S.keys[p.id]?.hint || "")}`} · ${p.models.length} models</small></span><button class="btn" data-manage="${esc(p.id)}">Manage</button></div>`)
    .join("");
  root.innerHTML = `
    <p class="muted small pad">Keys are encrypted with the Android Keystore and only ever sent to that provider's own servers. Chats and usage stay on this phone.</p>
    <div class="section"><span>Connected</span><button class="btn ghost" id="add-provider">Add</button></div>
    <div class="group">${rows || `<p class="muted pad">None yet. Add OpenCode Zen, Anthropic, OpenAI, Google, OpenRouter or any of ${S.catalog.length} providers.</p>`}</div>
    <div class="section">Model list</div>
    <div class="group"><button class="row" id="refresh-catalog"><span class="row-main"><span>Update models and prices</span><small>From models.dev · last updated ${S.catalogAt ? new Date(S.catalogAt).toLocaleDateString() : "never"}</small></span>${I.refresh}</button></div>`;
  $("#add-provider").addEventListener("click", () => addProviderFlow());
  $$("[data-manage]", root).forEach((b) => b.addEventListener("click", () => manageProvider(b.dataset.manage)));
  $("#refresh-catalog").addEventListener("click", async (e) => {
    e.currentTarget.querySelector("small").textContent = "Updating…";
    await refreshCatalog();
    renderProviders();
  });
}

function manageProvider(id) {
  const p = findProvider(id);
  const body = h(`<div class="menu">
    ${p.custom ? "" : `<button class="pick" data-a="replace"><span class="nav-ico">${I.key}</span><span class="pick-main"><b>Replace API key</b><small>${esc(S.keys[id]?.hint || "")}</small></span></button>`}
    ${p.doc ? `<a class="pick" href="${esc(p.doc)}" target="_blank" rel="noopener"><span class="nav-ico">${I.globe}</span><span class="pick-main"><b>Provider website</b><small>Keys, credit and usage</small></span></a>` : ""}
    <button class="pick danger" data-a="remove"><span class="nav-ico">${I.trash}</span><span class="pick-main"><b>Remove</b><small>Deletes the key from this phone</small></span></button></div>`);
  body.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "replace") {
      closeSheet();
      setTimeout(() => keyForm(p), 250);
    } else if (a === "remove") {
      if (!confirm(`Remove ${p.name}?`)) return;
      deleteKey(id);
      if (p.custom) {
        S.custom = S.custom.filter((c) => c.id !== id);
        await db.kv.set("custom", S.custom);
      }
      delete S.live[id];
      S.keys = keyHints();
      pickDefaultModel();
      closeSheet();
      renderProviders();
      renderProfile();
      toast(`${p.name} removed`);
    }
  });
  openSheet(p.name, body);
}

function addProviderFlow() {
  const body = h(`<div><input type="search" placeholder="Search ${S.catalog.length} providers" aria-label="Search providers" /><div class="list"></div></div>`);
  const list = $(".list", body);
  const draw = (q = "") => {
    list.innerHTML = "";
    q = q.toLowerCase();
    const custom = h(`<button class="pick"><span class="nav-ico">${I.sliders}</span><span class="pick-main"><b>Custom server</b><small>Ollama, LM Studio or any OpenAI-compatible API</small></span>${I.right}</button>`);
    custom.addEventListener("click", () => customForm());
    if (!q || "custom ollama lm studio local".includes(q)) list.append(custom);
    const items = S.catalog
      .filter((p) => !q || `${p.name} ${p.id}`.toLowerCase().includes(q))
      .sort((a, b) => (POPULAR.indexOf(a.id) + 1 || 99) - (POPULAR.indexOf(b.id) + 1 || 99) || a.name.localeCompare(b.name));
    for (const p of items.slice(0, q ? 80 : 30)) {
      const b = h(`<button class="pick"><span class="pick-main"><b>${esc(p.name)}</b><small>${p.models.length} models${S.keys[p.id] ? " · connected" : ""}</small></span>${I.right}</button>`);
      b.addEventListener("click", () => {
        closeSheet();
        setTimeout(() => keyForm(p), 250);
      });
      list.append(b);
    }
    if (!q && items.length > 30) list.append(h(`<p class="muted small pad">Search to see all ${items.length}</p>`));
  };
  draw();
  $("input", body).addEventListener("input", (e) => draw(e.target.value));
  openSheet("Add a provider", body);
}

function keyForm(p) {
  const f = h(`<form class="stack" style="padding:4px 8px 12px">
    <input type="password" name="key" autocomplete="off" placeholder="API key" required aria-label="API key" />
    <small class="muted">Stored encrypted on this phone and only sent to ${esc(hostsFor(p).join(", "))}.${p.id === "opencode" || p.id === "opencode-go" ? " Get a key at opencode.ai/console." : ""}</small>
    ${p.doc ? `<a class="small" href="${esc(p.doc)}" target="_blank" rel="noopener">Where do I get a key?</a>` : ""}
    <button class="btn accent block">Save key</button></form>`);
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const err = saveKey(p.id, f.key.value.trim(), hostsFor(p));
    if (err) return toast(err, "error");
    S.keys = keyHints();
    closeSheet();
    toast(`${p.name} connected`);
    buzz([10, 40, 10]);
    if (!find()) pickDefaultModel();
    renderProfile();
    if (!$("#page-providers").hidden) renderProviders();
    if (!S.chat.messages.length) renderChat();
    refreshLive([p.id]);
  });
  openSheet(`Connect ${p.name}`, f);
  setTimeout(() => f.key.focus(), 60);
}

function customForm() {
  closeSheet();
  const f = h(`<form class="stack" style="padding:4px 8px 12px">
    <label class="field"><span>Name</span><input name="name" placeholder="My Ollama" required /></label>
    <label class="field"><span>Base URL (OpenAI-compatible)</span><input name="api" type="url" inputmode="url" autocapitalize="off" placeholder="http://192.168.1.20:11434/v1" required /></label>
    <label class="field"><span>Model IDs (comma-separated)</span><input name="models" autocapitalize="off" placeholder="llama3.3, qwen3" required /></label>
    <label class="field"><span>API key (optional)</span><input name="key" type="password" autocomplete="off" /></label>
    <button class="btn accent block">Add</button></form>`);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    let host;
    try {
      host = new URL(f.api.value.trim()).host;
    } catch {
      return toast("That URL doesn't look right", "error");
    }
    const c = { id: `custom-${uid()}`, name: f.name.value.trim(), api: f.api.value.trim(), models: f.models.value.split(",").map((s) => s.trim()).filter(Boolean) };
    if (f.key.value.trim()) {
      const err = saveKey(c.id, f.key.value.trim(), [host]);
      if (err) return toast(err, "error");
    }
    S.custom.push(c);
    await db.kv.set("custom", S.custom);
    S.keys = keyHints();
    closeSheet();
    toast(`${c.name} added`);
    if (!find()) pickDefaultModel();
    renderProfile();
    if (!$("#page-providers").hidden) renderProviders();
    if (!S.chat.messages.length) renderChat();
  });
  setTimeout(() => openSheet("Custom server", f), 250);
}

// ── settings page ─────────────────────────────────────────────────────────────────────
function renderSettings() {
  const root = $("#settings");
  const tog = (k, label, hint = "") => `<label class="switch"><span class="row-main"><span>${label}</span>${hint ? `<small>${hint}</small>` : ""}</span><input type="checkbox" data-pref="${k}" ${prefs[k] ? "checked" : ""}/><i></i></label>`;
  root.innerHTML = `
    <div class="section">You</div>
    <div class="group" style="padding:10px 14px"><label class="field"><span>Your name (for greetings)</span><input id="pref-name" value="${esc(prefs.name)}" maxlength="40" placeholder="Optional" /></label></div>
    <div class="section">Appearance</div>
    <div class="seg" role="group" aria-label="Appearance">${["system", "light", "dark"].map((m) => `<button data-appearance="${m}" aria-pressed="${prefs.appearance === m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join("")}</div>
    <div class="section"><span>Text size</span><span id="scale-val">${Math.round(prefs.fontScale * 100)}%</span></div>
    <div class="group" style="padding:4px 14px"><input type="range" min="0.85" max="1.3" step="0.05" value="${prefs.fontScale}" id="scale" aria-label="Text size" /></div>
    <div class="section">Chat</div>
    <div class="group" style="padding:10px 14px"><label class="field"><span>Instructions for every chat</span><textarea id="pref-system" rows="3">${esc(prefs.system)}</textarea></label></div>
    <div class="group" style="margin-top:8px">
      ${tog("showReasoning", "Show thinking", "See the model's reasoning when it shares it")}
      ${tog("enterSends", "Enter to send", "Otherwise Enter adds a new line")}
      ${tog("notify", "Notify when done", "If you leave the app while a reply is coming in")}
      ${tog("wakeLock", "Keep screen on", "While a reply is coming in")}
      ${tog("haptics", "Haptic feedback")}
    </div>
    <div class="section">Your data</div>
    <div class="group">
      <button class="row" id="export"><span class="nav-ico">${I.download}</span><span class="row-main"><span>Export chats</span><small>${S.chats.length} chats and your token history, as a file (no keys)</small></span></button>
      <button class="row" id="import"><span class="nav-ico">${I.upload}</span><span class="row-main"><span>Import chats</span><small>From an export file</small></span></button>
      <button class="row bad" id="wipe"><span class="nav-ico bad">${I.trash}</span><span class="row-main"><span>Delete all chats</span><small>Token history is kept</small></span></button>
    </div>
    <p class="muted small pad">opencode·pixel ${esc(native?.version?.() || "")} · runs on this phone · models from models.dev</p>`;
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
  } else if (t.id === "export") {
    const data = JSON.stringify(await db.exportAll());
    const name = `opencode-pixel-${new Date().toISOString().slice(0, 10)}.json`;
    if (native) native.saveFile(name, "application/json", data);
    else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
      a.download = name;
      a.click();
    }
  } else if (t.id === "import") {
    $("#import-input").click();
  } else if (t.id === "wipe") {
    if (!confirm(`Delete all ${S.chats.length} chats? This can't be undone.`)) return;
    S.streaming?.abort();
    await db.chats.clear();
    S.chats = [];
    newChat(false);
    renderSettings();
    toast("All chats deleted");
  }
});
window.__ocpSaved = (ok, msg) => toast(ok ? "Export saved" : msg || "Export cancelled", ok ? "info" : "error");
$("#import-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const n = await db.importAll(JSON.parse(await file.text()));
    S.chats = ((await db.chats.all()) || []).sort((a, b) => b.updated - a.updated);
    S.usage = (await db.usage.all()) || [];
    S.stats = summarize(S.usage);
    S.budgets = (await db.kv.get("budgets")) || S.budgets;
    S.custom = (await db.kv.get("custom")) || S.custom;
    renderSettings();
    renderProfile();
    toast(`Imported ${n} chats`);
  } catch (err) {
    toast(`Import failed: ${err.message}`, "error");
  }
});
$("#settings").addEventListener("change", async (e) => {
  const k = e.target.dataset.pref;
  if (k) {
    prefs[k] = e.target.checked;
    if (k === "notify" && prefs.notify) {
      if (native && !native.canNotify()) {
        window.__ocpNotifyPermission = (ok) => {
          prefs.notify = ok;
          e.target.checked = ok;
          savePrefs();
          if (!ok) toast("Notifications are off for opencode in Android settings", "error");
        };
        native.requestNotifications();
      } else if (!native && "Notification" in window && Notification.permission !== "granted") {
        prefs.notify = (await Notification.requestPermission()) === "granted";
        e.target.checked = prefs.notify;
      }
    }
    savePrefs();
    buzz();
    if (k === "showReasoning") renderChat();
  }
  if (e.target.id === "pref-system") {
    prefs.system = e.target.value.trim();
    savePrefs();
    toast("Instructions saved");
  }
  if (e.target.id === "pref-name") {
    prefs.name = e.target.value.trim();
    savePrefs();
    renderProfile();
    if (!S.chat.messages.length) renderChat();
  }
});
$("#settings").addEventListener("input", (e) => {
  if (e.target.id !== "scale") return;
  prefs.fontScale = Number(e.target.value);
  document.documentElement.style.setProperty("--scale", prefs.fontScale);
  $("#scale-val").textContent = `${Math.round(prefs.fontScale * 100)}%`;
  savePrefs();
});

// Deep links while running (notification taps, shortcuts, shares): the app calls this.
window.__ocpOpen = (query) => {
  const q = new URLSearchParams(query);
  while (layers.length) layers.pop().close(true);
  if (q.get("chat")) openChat(q.get("chat"));
  else if (q.has("new") || q.get("text")) newChat(false);
  if (q.get("text")) {
    $("#prompt").value = q.get("text");
    $("#prompt").dispatchEvent(new Event("input"));
  }
  if (PAGES[q.get("page")]) openPage(q.get("page"));
};

boot().catch((e) => toast(`Startup failed: ${e.message}`, "error", 10000));
