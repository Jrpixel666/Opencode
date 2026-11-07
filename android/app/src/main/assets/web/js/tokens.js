// Token balances. Everything the app shows is in tokens; money only appears internally,
// to turn a provider's credit into "tokens left" at each model's list price.
//
// Ledger entry (one per reply): { time, providerID, modelID, input, output, reasoning,
//   cacheRead, cacheWrite, cost, est }   (cost in USD at list price; est = usage estimated)
//
// Budgets: {
//   providers: { [id]: { type: "credit", amount, asOf }                    // USD you had at asOf
//                    | { type: "tokens", amount, period, asOf } },         // token allowance
//   models:    { ["provider/model"]: { amount, period } }                   // token limit
// }
// period: "once" (since asOf) | "day" | "week" | "month" (calendar, local time)

export const total = (e) => (e.input || 0) + (e.output || 0) + (e.cacheRead || 0) + (e.cacheWrite || 0);

/** Cost in USD of one reply at list price (model prices are per 1M tokens). */
export function costOf(model, u) {
  if (!model) return 0;
  const cr = model.cr || model.in || 0;
  return ((u.input || 0) * (model.in || 0) + (u.cacheRead || 0) * cr + (u.cacheWrite || 0) * (model.in || 0) + (u.output || 0) * (model.out || 0)) / 1e6;
}

export function periodStart(period, asOf = 0, now = Date.now()) {
  const d = new Date(now);
  if (period === "day") return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (period === "week") {
    const day = (d.getDay() + 6) % 7; // Monday = 0
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime();
  }
  if (period === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return asOf || 0;
}

const H = 3_600_000;
export const WINDOWS = { "5h": 5 * H, day: 24 * H, week: 7 * 24 * H, month: 30 * 24 * H };

/** Per-model and per-provider token totals with rolling windows. */
export function summarize(entries, now = Date.now()) {
  const models = {};
  const providers = {};
  const all = blank();
  function blank() {
    return { tokens: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0, replies: 0, last: 0, w: { "5h": 0, day: 0, week: 0, month: 0 } };
  }
  const add = (b, e) => {
    const t = total(e);
    b.tokens += t;
    b.input += e.input || 0;
    b.output += e.output || 0;
    b.cacheRead += e.cacheRead || 0;
    b.reasoning += e.reasoning || 0;
    b.replies += 1;
    b.last = Math.max(b.last, e.time || 0);
    for (const [k, ms] of Object.entries(WINDOWS)) if (now - e.time <= ms) b.w[k] += t;
  };
  for (const e of entries) {
    add((models[`${e.providerID}/${e.modelID}`] ||= blank()), e);
    add((providers[e.providerID] ||= blank()), e);
    add(all, e);
  }
  return { models, providers, all };
}

const sum = (entries, pred, f) => entries.reduce((s, e) => (pred(e) ? s + f(e) : s), 0);

/**
 * USD per token for a model, blended by how you actually use it (your input:output ratio on
 * that model; 3:1 until there's history). Returns 0 for free models, null if price unknown.
 */
export function blendedPrice(model, stats) {
  if (!model || model.nc) return null;
  if (!model.in && !model.out) return 0;
  const inT = stats ? stats.input + stats.cacheRead : 0;
  const outT = stats ? stats.output : 0;
  const ratioIn = inT + outT > 0 ? inT / (inT + outT) : 0.75;
  return (ratioIn * (model.in || 0) + (1 - ratioIn) * (model.out || 0)) / 1e6;
}

/**
 * Tokens left for one model, or:
 *   Infinity – the model is free
 *   null     – no balance known (no credit, allowance or limit set)
 * Also returns where the number came from.
 */
export function tokensLeft({ provider, model, entries, budgets, live, stats, now = Date.now() }) {
  const key = `${provider.id}/${model.id}`;
  const price = blendedPrice(model, stats);
  const candidates = [];
  const pb = budgets?.providers?.[provider.id];
  const lv = live?.[provider.id];

  if (lv && Number.isFinite(lv.credit) && price) {
    candidates.push({ tokens: Math.max(0, lv.credit) / price, source: "live" });
  } else if (pb?.type === "credit" && price) {
    const spent = sum(entries, (e) => e.providerID === provider.id && e.time >= pb.asOf, (e) => e.cost || 0);
    candidates.push({ tokens: Math.max(0, pb.amount - spent) / price, source: "credit" });
  } else if (pb?.type === "tokens") {
    const since = periodStart(pb.period, pb.asOf, now);
    const used = sum(entries, (e) => e.providerID === provider.id && e.time >= since, total);
    candidates.push({ tokens: Math.max(0, pb.amount - used), source: "allowance" });
  }

  const ml = budgets?.models?.[key];
  if (ml) {
    const since = periodStart(ml.period, ml.asOf, now);
    const used = sum(entries, (e) => `${e.providerID}/${e.modelID}` === key && e.time >= since, total);
    candidates.push({ tokens: Math.max(0, ml.amount - used), source: "limit" });
  }

  if (!candidates.length) return price === 0 ? { tokens: Infinity, source: "free" } : { tokens: null, source: "none" };
  return candidates.reduce((a, b) => (b.tokens < a.tokens ? b : a));
}

/** "4.2M", "380K", "950". */
export function fmtTokens(n) {
  if (n === Infinity) return "Unlimited";
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}
