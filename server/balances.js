// Balance per provider and per model.
//
// Sources, best first:
//   live    – the provider exposes a balance API (OpenRouter, DeepSeek, Moonshot, SiliconFlow)
//   manual  – you typed in your balance (e.g. OpenCode Zen credits, which have no public API);
//             the bridge subtracts what opencode has spent on that provider since then
//   none    – nothing known; spend is still shown
//
// Per-model limits (OpenCode Go style: 5-hour 20 %, weekly 50 %, monthly 100 % of a monthly
// dollar limit) can be set per model and are checked against the spend ledger.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { oc } from "./opencode.js";
import { allUsage, summarize, spendSince, WINDOWS } from "./usage.js";

const budgetsFile = path.join(config.dataDir, "budgets.json");

export function readBudgets() {
  try {
    const b = JSON.parse(fs.readFileSync(budgetsFile, "utf8"));
    return { providers: b.providers || {}, limits: b.limits || {} };
  } catch {
    return { providers: {}, limits: {} };
  }
}

export function writeBudgets(next) {
  const clean = { providers: {}, limits: {} };
  for (const [id, v] of Object.entries(next?.providers || {})) {
    const balance = Number(v?.balance);
    if (!Number.isFinite(balance)) continue;
    clean.providers[id] = { balance, currency: String(v.currency || "USD").slice(0, 8), asOf: Number(v.asOf) || Date.now() };
  }
  for (const [key, v] of Object.entries(next?.limits || {})) {
    const monthly = Number(v?.monthly);
    if (!Number.isFinite(monthly) || monthly <= 0) continue;
    clean.limits[key] = {
      monthly,
      split: { "5h": num(v?.split?.["5h"], 0.2), week: num(v?.split?.week, 0.5), month: num(v?.split?.month, 1) },
    };
  }
  fs.writeFileSync(budgetsFile, JSON.stringify(clean, null, 2), { mode: 0o600 });
  return clean;
}

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

// ---- credentials (never sent to the phone, only a masked hint) ----------------------

export function readAuthFile() {
  try {
    return JSON.parse(fs.readFileSync(config.authFile, "utf8")) || {};
  } catch {
    return {};
  }
}

export function maskKey(key) {
  if (!key || key.length < 8) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function apiKeyFor(providerID, envNames, auth) {
  const a = auth[providerID];
  if (a?.type === "api" && a.key) return a.key;
  if (a?.type === "wellknown" && a.token) return a.token;
  for (const name of envNames || []) if (process.env[name]) return process.env[name];
  return null;
}

// ---- live balance checkers ----------------------------------------------------------

async function getJson(url, key) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const LIVE = {
  openrouter: async (key) => {
    const { data } = await getJson("https://openrouter.ai/api/v1/credits", key);
    return { amount: data.total_credits - data.total_usage, currency: "USD", detail: `credits ${fmt(data.total_credits)} · used ${fmt(data.total_usage)}` };
  },
  deepseek: async (key) => {
    const d = await getJson("https://api.deepseek.com/user/balance", key);
    const b = d.balance_infos?.find((x) => x.currency === "USD") || d.balance_infos?.[0];
    if (!b) throw new Error("no balance info");
    return { amount: Number(b.total_balance), currency: b.currency, detail: `topped up ${b.topped_up_balance} · granted ${b.granted_balance}${d.is_available ? "" : " · UNAVAILABLE"}` };
  },
  moonshotai: async (key) => {
    const { data } = await getJson("https://api.moonshot.ai/v1/users/me/balance", key);
    return { amount: data.available_balance, currency: "USD", detail: `cash ${data.cash_balance} · voucher ${data.voucher_balance}` };
  },
  "moonshotai-cn": async (key) => {
    const { data } = await getJson("https://api.moonshot.cn/v1/users/me/balance", key);
    return { amount: data.available_balance, currency: "CNY", detail: `cash ${data.cash_balance} · voucher ${data.voucher_balance}` };
  },
  siliconflow: async (key) => {
    const { data } = await getJson("https://api.siliconflow.com/v1/user/info", key);
    return { amount: Number(data.totalBalance), currency: "USD", detail: `charged ${data.chargeBalance} · granted ${data.balance}` };
  },
};

// Providers that sell a subscription instead of metered credits when logged in via OAuth.
const SUBSCRIPTION_OAUTH = { anthropic: "Claude Pro/Max subscription", "github-copilot": "GitHub Copilot subscription", openai: "ChatGPT subscription" };

const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

const liveCache = new Map(); // providerID -> { at, value }
async function liveBalance(providerID, key, force) {
  const hit = liveCache.get(providerID);
  if (!force && hit && Date.now() - hit.at < 60_000) return hit.value;
  let value;
  try {
    value = { source: "live", ...(await LIVE[providerID](key)), asOf: Date.now() };
  } catch (e) {
    value = { source: "live", error: e.message, asOf: Date.now() };
  }
  liveCache.set(providerID, { at: Date.now(), value });
  return value;
}

// ---- the report the Balance screen renders ------------------------------------------

export async function balanceReport({ force = false } = {}) {
  const [list, entries] = await Promise.all([oc("GET", "/provider"), allUsage({ force }).catch(() => [])]);
  const auth = readAuthFile();
  const budgets = readBudgets();
  const now = Date.now();
  const usage = summarize(entries, now);
  const connected = new Set(list?.connected || []);
  // Include anything with spend even if it has since been disconnected.
  for (const id of Object.keys(usage.providers)) connected.add(id);

  const providers = [];
  const models = [];
  for (const p of list?.all || []) {
    if (!connected.has(p.id)) continue;
    const a = auth[p.id];
    const key = apiKeyFor(p.id, p.env, auth);
    let balance = { source: "none" };
    if (config.demo && LIVE[p.id]) balance = { source: "live", amount: 18.42, currency: "USD", detail: "demo · credits 25.00 · used 6.58", asOf: now };
    else if (LIVE[p.id] && key) balance = await liveBalance(p.id, key, force);
    else if (budgets.providers[p.id]) {
      const m = budgets.providers[p.id];
      const spent = spendSince(entries, p.id, m.asOf);
      balance = { source: "manual", amount: m.balance - spent, currency: m.currency, asOf: m.asOf, detail: `${fmt(m.balance)} set ${new Date(m.asOf).toLocaleDateString()} − ${fmt(spent)} spent since` };
    } else if (a?.type === "oauth" && SUBSCRIPTION_OAUTH[p.id]) {
      balance = { source: "subscription", detail: SUBSCRIPTION_OAUTH[p.id] };
    }
    providers.push({
      id: p.id,
      name: p.name,
      connected: (list?.connected || []).includes(p.id),
      auth: a ? { type: a.type, hint: a.type === "api" ? maskKey(a.key) : a.type === "wellknown" ? maskKey(a.token) : null, expires: a.expires || null } : key ? { type: "env", hint: maskKey(key) } : null,
      liveSupported: Boolean(LIVE[p.id]),
      balance,
      spend: usage.providers[p.id] || null,
    });

    for (const m of Object.values(p.models || {})) {
      const mkey = `${p.id}/${m.id}`;
      const spend = usage.models[mkey] || null;
      const cost = m.cost || { input: 0, output: 0 };
      const free = !cost.input && !cost.output;
      const available = Number.isFinite(balance.amount) ? balance.amount : null;
      const limit = budgets.limits[mkey];
      let limits = null;
      if (limit) {
        limits = {};
        for (const w of ["5h", "week", "month"]) {
          const cap = limit.monthly * limit.split[w];
          const used = spend?.windows[w] || 0;
          limits[w] = { used, cap, left: Math.max(0, cap - used) };
        }
      }
      // What you can still spend on this model: the provider balance, capped by any model limit.
      let spendable = available;
      if (limits) {
        const tightest = Math.min(limits["5h"].left, limits.week.left, limits.month.left);
        spendable = spendable === null ? tightest : Math.min(spendable, tightest);
      }
      models.push({
        key: mkey,
        providerID: p.id,
        providerName: p.name,
        modelID: m.id,
        name: m.name,
        status: m.status || "active",
        reasoning: m.reasoning,
        attachment: m.attachment,
        context: m.limit?.context || 0,
        cost: { input: cost.input || 0, output: cost.output || 0, cacheRead: cost.cache_read || 0 },
        free,
        spend,
        spendable,
        currency: balance.currency || "USD",
        // Rough tokens left if spent entirely on input or entirely on output ($ per 1M tokens).
        tokensLeft: spendable !== null && !free ? { input: cost.input ? (spendable / cost.input) * 1e6 : null, output: cost.output ? (spendable / cost.output) * 1e6 : null } : null,
        limits,
      });
    }
  }

  models.sort((a, b) => (b.spend?.last || 0) - (a.spend?.last || 0) || a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name));
  const total = Object.values(usage.providers).reduce(
    (t, p) => ({ cost: t.cost + p.cost, requests: t.requests + p.requests, month: t.month + p.windows.month, day: t.day + p.windows.day }),
    { cost: 0, requests: 0, month: 0, day: 0 },
  );
  return { generatedAt: now, windows: Object.keys(WINDOWS), providers, models, total, defaults: list?.default || {} };
}
