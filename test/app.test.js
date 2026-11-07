// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

const W = "../android/app/src/main/assets/web/js";
const { markdown } = await import(`${W}/markdown.js`);
const { buildRequest, createParser, errorMessage } = await import(`${W}/llm.js`);
const { slimCatalog, endpoint, hostsFor } = await import(`${W}/catalog.js`);
const { summarize, tokensLeft, blendedPrice, costOf, periodStart, fmtTokens } = await import(`${W}/tokens.js`);

// Feed a stream to a parser in awkward pieces, to prove line buffering works.
function run(style, text, pieceSize = 7) {
  const p = createParser(style);
  const events = [];
  for (let i = 0; i < text.length; i += pieceSize) events.push(...p.push(text.slice(i, i + pieceSize)));
  events.push(...p.end());
  const join = (t) => events.filter((e) => e.type === t).map((e) => e.delta).join("");
  return { text: join("text"), reasoning: join("reasoning"), usage: p.usage(), errors: events.filter((e) => e.type === "error"), events };
}
const sse = (objs) => objs.map((o) => (typeof o === "string" ? `data: ${o}\n\n` : `data: ${JSON.stringify(o)}\n\n`)).join("");

test("markdown escapes HTML and only allows http(s) links", () => {
  const html = markdown("<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://ok.dev)");
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes('href="https://ok.dev"'));
});

test("chat-completions stream: text, reasoning and usage (cached tokens split out)", () => {
  const r = run("chat", sse([
    { choices: [{ delta: { reasoning_content: "Let me " } }] },
    { choices: [{ delta: { reasoning_content: "think." } }] },
    { choices: [{ delta: { content: "Hello" } }] },
    { choices: [{ delta: { content: ", wörld 👋" } }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 10 } } },
    "[DONE]",
  ]));
  assert.equal(r.text, "Hello, wörld 👋");
  assert.equal(r.reasoning, "Let me think.");
  assert.deepEqual(r.usage, { input: 20, output: 30, reasoning: 10, cacheRead: 100, cacheWrite: 0 });
});

test("chat stream error payload becomes an error event", () => {
  const r = run("chat", sse([{ error: { message: "Insufficient account funds" } }]));
  assert.equal(r.errors[0].message, "Insufficient account funds");
});

test("anthropic stream: thinking, text and usage across events", () => {
  const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const text =
    ev("message_start", { type: "message_start", message: { usage: { input_tokens: 50, cache_read_input_tokens: 400, output_tokens: 1 } } }) +
    ev("content_block_delta", { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Hmm" } }) +
    ev("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "Hi " } }) +
    ev("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "there" } }) +
    ev("message_delta", { type: "message_delta", usage: { output_tokens: 42 } }) +
    ev("message_stop", { type: "message_stop" });
  const r = run("anthropic", text, 5);
  assert.equal(r.text, "Hi there");
  assert.equal(r.reasoning, "Hmm");
  assert.deepEqual(r.usage, { input: 50, output: 42, reasoning: 0, cacheRead: 400, cacheWrite: 0 });
});

test("responses stream: deltas and final usage", () => {
  const r = run("responses", sse([
    { type: "response.reasoning_summary_text.delta", delta: "plan" },
    { type: "response.output_text.delta", delta: "Answer" },
    { type: "response.completed", response: { usage: { input_tokens: 300, input_tokens_details: { cached_tokens: 200 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 60 } } } },
  ]));
  assert.equal(r.text, "Answer");
  assert.equal(r.reasoning, "plan");
  assert.deepEqual(r.usage, { input: 100, output: 80, reasoning: 60, cacheRead: 200, cacheWrite: 0 });
});

test("gemini stream: thought parts, text and final usage; works without a trailing blank line", () => {
  const body = sse([
    { candidates: [{ content: { parts: [{ text: "considering", thought: true }] } }] },
    { candidates: [{ content: { parts: [{ text: "Bonjour" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 5 } },
  ]).replace(/\n\n$/, "");
  const r = run("google", body);
  assert.equal(r.text, "Bonjour");
  assert.equal(r.reasoning, "considering");
  assert.deepEqual(r.usage, { input: 10, output: 7, reasoning: 5, cacheRead: 0, cacheWrite: 0 });
});

test("request bodies carry images in each API's own format", () => {
  const img = "data:image/png;base64,AAAA";
  const msgs = [{ role: "user", text: "what's this?", images: [img] }];
  const model = { id: "m", max: 64000, r: 1 };
  const chat = JSON.parse(buildRequest("chat", model, msgs, { system: "be nice" }).body);
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[1].content[1].image_url.url, img);
  assert.equal(chat.stream_options.include_usage, true);
  const a = buildRequest("anthropic", model, msgs, { system: "be nice" });
  const ab = JSON.parse(a.body);
  assert.equal(a.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(ab.messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  assert.equal(ab.max_tokens, 32000);
  const g = JSON.parse(buildRequest("google", model, msgs).body);
  assert.deepEqual(g.contents[0].parts[0], { inline_data: { mime_type: "image/png", data: "AAAA" } });
  const resp = JSON.parse(buildRequest("responses", model, [...msgs, { role: "assistant", text: "a cat" }]).body);
  assert.equal(resp.input[1].content[0].type, "output_text");
  assert.deepEqual(resp.reasoning, { summary: "auto" });
});

test("HTTP errors read nicely", () => {
  assert.match(errorMessage(401, '{"error":{"message":"bad key"}}'), /rejected.*bad key/);
  assert.match(errorMessage(402, "Insufficient account funds"), /Out of credit/);
});

test("catalog: routing per model and key hosts", () => {
  const raw = {
    opencode: {
      name: "OpenCode Zen", api: "https://opencode.ai/inference/openai/v1", npm: "@ai-sdk/openai-compatible",
      models: {
        "claude-x": { name: "Claude X", cost: { input: 3, output: 15 }, limit: { context: 200000, output: 64000 }, provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/anthropic/v1" } },
        "free-y": { name: "Free Y", cost: { input: 0, output: 0 }, limit: { context: 1000, output: 100 } },
        old: { name: "Old", status: "deprecated" },
      },
    },
    anthropic: { name: "Anthropic", npm: "@ai-sdk/anthropic", models: { c: { name: "C" } } },
    weird: { name: "No API", npm: "@some/sdk", models: { z: {} } },
  };
  const { providers } = slimCatalog(raw);
  assert.deepEqual(providers.map((p) => p.id), ["anthropic", "opencode"]);
  const zen = providers.find((p) => p.id === "opencode");
  assert.equal(zen.models.length, 2);
  const claude = zen.models.find((m) => m.id === "claude-x");
  assert.deepEqual(endpoint(zen, claude), { style: "anthropic", url: "https://opencode.ai/inference/anthropic/v1/messages", auth: "x-api-key" });
  assert.equal(endpoint(zen, zen.models.find((m) => m.id === "free-y")).url, "https://opencode.ai/inference/openai/v1/chat/completions");
  assert.deepEqual(hostsFor(zen), ["opencode.ai"]);
  const an = providers.find((p) => p.id === "anthropic");
  assert.equal(endpoint(an, an.models[0]).url, "https://api.anthropic.com/v1/messages");
  assert.equal(an.models[0].nc, 1); // no price known
});

test("tokens: rolling windows and totals", () => {
  const now = 1_800_000_000_000;
  const H = 3_600_000;
  const e = (modelID, ago, input, output) => ({ providerID: "p", modelID, time: now - ago, input, output, cacheRead: 0 });
  const s = summarize([e("a", H, 100, 50), e("a", 30 * H, 1000, 0), e("b", 40 * 24 * H, 5, 5)], now);
  assert.equal(s.models["p/a"].w["5h"], 150);
  assert.equal(s.models["p/a"].w.week, 1150);
  assert.equal(s.models["p/b"].w.month, 0);
  assert.equal(s.all.tokens, 1160);
});

test("tokens left: credit converted at a blended price, minus spend since it was set", () => {
  const provider = { id: "p" };
  const model = { id: "m", in: 2, out: 10 }; // $ per 1M
  // No history → 75% input / 25% output → $4 per 1M tokens.
  assert.equal(blendedPrice(model, null), 4 / 1e6);
  const budgets = { providers: { p: { type: "credit", amount: 10, asOf: 1000 } }, models: {} };
  const spent = { providerID: "p", modelID: "m", time: 2000, input: 0, output: 0, cost: 2 };
  const l = tokensLeft({ provider, model, entries: [spent], budgets, live: {}, stats: null });
  assert.equal(l.source, "credit");
  assert.equal(Math.round(l.tokens), 2_000_000); // ($10 − $2) / $4 per 1M
  assert.equal(costOf(model, { input: 1e6, output: 1e6 }), 12);
});

test("tokens left: live credit, token allowances, model limits and free models", () => {
  const provider = { id: "p" };
  const model = { id: "m", in: 1, out: 1 };
  const now = Date.now();
  const used = { providerID: "p", modelID: "m", time: now - 1000, input: 300_000, output: 200_000 };
  assert.equal(Math.round(tokensLeft({ provider, model, entries: [], budgets: {}, live: { p: { credit: 5 } } }).tokens), 5_000_000);
  const allowance = { providers: { p: { type: "tokens", amount: 2_000_000, period: "month", asOf: 0 } }, models: {} };
  assert.equal(tokensLeft({ provider, model, entries: [used], budgets: allowance, now }).tokens, 1_500_000);
  const withLimit = { ...allowance, models: { "p/m": { amount: 600_000, period: "day" } } };
  const l = tokensLeft({ provider, model, entries: [used], budgets: withLimit, now });
  assert.deepEqual([l.tokens, l.source], [100_000, "limit"]);
  assert.equal(tokensLeft({ provider, model: { id: "f", in: 0, out: 0 }, entries: [], budgets: {} }).tokens, Infinity);
  assert.equal(tokensLeft({ provider, model: { id: "u", nc: 1 }, entries: [], budgets: {} }).tokens, null);
});

test("period starts and number formatting", () => {
  const now = new Date(2026, 10, 7, 15, 30).getTime(); // Sat 7 Nov 2026
  assert.equal(periodStart("day", 0, now), new Date(2026, 10, 7).getTime());
  assert.equal(periodStart("week", 0, now), new Date(2026, 10, 2).getTime()); // Monday
  assert.equal(periodStart("month", 0, now), new Date(2026, 10, 1).getTime());
  assert.equal(periodStart("once", 123, now), 123);
  assert.deepEqual([fmtTokens(950), fmtTokens(12_400), fmtTokens(4_200_000), fmtTokens(Infinity)], ["950", "12K", "4.2M", "Unlimited"]);
});
