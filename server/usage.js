// Spend ledger: sums the cost opencode records on every assistant message, per model.
// opencode stores `cost` (USD) and token counts on each AssistantMessage, so this works
// for every provider, including ones with no balance API (OpenCode Zen, Anthropic, ...).
import { oc } from "./opencode.js";

const cache = new Map(); // sessionID -> { updated, entries }
let lastScan = { at: 0, entries: [] };

async function sessionEntries(session) {
  const hit = cache.get(session.id);
  if (hit && hit.updated === session.time?.updated) return hit.entries;
  const messages = await oc("GET", `/session/${encodeURIComponent(session.id)}/message`);
  const entries = [];
  for (const { info } of messages || []) {
    if (info?.role !== "assistant") continue;
    entries.push({
      providerID: info.providerID,
      modelID: info.modelID,
      cost: Number(info.cost) || 0,
      time: info.time?.created || 0,
      input: info.tokens?.input || 0,
      output: info.tokens?.output || 0,
      reasoning: info.tokens?.reasoning || 0,
      cacheRead: info.tokens?.cache?.read || 0,
      cacheWrite: info.tokens?.cache?.write || 0,
    });
  }
  cache.set(session.id, { updated: session.time?.updated, entries });
  return entries;
}

// Returns every assistant-message usage entry across all sessions (cached ~20 s).
export async function allUsage({ force = false } = {}) {
  if (!force && Date.now() - lastScan.at < 20_000) return lastScan.entries;
  const sessions = (await oc("GET", "/session")) || [];
  const entries = [];
  // Small concurrency pool so a big history doesn't hammer the server.
  const queue = [...sessions];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const s = queue.shift();
        try {
          entries.push(...(await sessionEntries(s)));
        } catch {
          /* a deleted/unreadable session shouldn't break the ledger */
        }
      }
    }),
  );
  lastScan = { at: Date.now(), entries };
  return entries;
}

const H = 3_600_000;
export const WINDOWS = { "5h": 5 * H, day: 24 * H, week: 7 * 24 * H, month: 30 * 24 * H };

// Aggregate entries into per-model and per-provider totals with rolling windows.
export function summarize(entries, now = Date.now()) {
  const models = {};
  const providers = {};
  const blank = () => ({ cost: 0, requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, windows: { "5h": 0, day: 0, week: 0, month: 0 }, last: 0 });
  const add = (bucket, e) => {
    bucket.cost += e.cost;
    bucket.requests += 1;
    bucket.input += e.input;
    bucket.output += e.output;
    bucket.reasoning += e.reasoning;
    bucket.cacheRead += e.cacheRead;
    bucket.cacheWrite += e.cacheWrite;
    bucket.last = Math.max(bucket.last, e.time);
    for (const [k, ms] of Object.entries(WINDOWS)) if (now - e.time <= ms) bucket.windows[k] += e.cost;
  };
  for (const e of entries) {
    const key = `${e.providerID}/${e.modelID}`;
    add((models[key] ||= blank()), e);
    add((providers[e.providerID] ||= blank()), e);
  }
  return { models, providers };
}

export function spendSince(entries, providerID, since) {
  return entries.filter((e) => e.providerID === providerID && e.time >= since).reduce((s, e) => s + e.cost, 0);
}
