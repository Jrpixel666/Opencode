// Providers and models, from models.dev (the open model database opencode uses), plus how to
// talk to each one directly from the phone.
//
// API styles:
//   chat       – OpenAI-compatible  POST {api}/chat/completions
//   responses  – OpenAI Responses   POST {api}/responses
//   anthropic  – Anthropic Messages POST {api}/messages
//   google     – Gemini             POST {api}/models/{id}:streamGenerateContent?alt=sse

// Base URLs for providers whose models.dev entry relies on an SDK default instead of an "api".
const DEFAULT_API = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  perplexity: "https://api.perplexity.ai",
  cohere: "https://api.cohere.ai/compatibility/v1",
};

// Shown first when adding a provider.
export const POPULAR = ["opencode", "opencode-go", "anthropic", "openai", "google", "openrouter", "deepseek", "xai", "groq", "mistral", "moonshotai"];

function styleFor(npm) {
  if (npm === "@ai-sdk/anthropic") return "anthropic";
  if (npm === "@ai-sdk/google") return "google";
  if (npm === "@ai-sdk/openai") return "responses";
  return "chat";
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Reduces models.dev's api.json (~6 MB) to what the app needs. */
export function slimCatalog(raw) {
  const providers = [];
  for (const [id, p] of Object.entries(raw || {})) {
    const api = p.api || DEFAULT_API[id];
    if (!api) continue; // needs an SDK we can't speak directly
    const models = [];
    for (const [mid, m] of Object.entries(p.models || {})) {
      if (m.status === "deprecated") continue;
      if (m.modalities && !(m.modalities.output || []).includes("text")) continue;
      const mApi = m.provider?.api || api;
      const mNpm = m.provider?.npm || p.npm;
      const entry = {
        id: mid,
        name: m.name || mid,
        in: num(m.cost?.input),
        out: num(m.cost?.output),
        cr: num(m.cost?.cache_read),
        ctx: num(m.limit?.context),
        max: num(m.limit?.output),
      };
      if (m.reasoning) entry.r = 1;
      if (m.attachment || (m.modalities?.input || []).includes("image")) entry.img = 1;
      if (m.status && m.status !== "active") entry.st = m.status;
      if (!m.cost) entry.nc = 1; // price unknown
      const st = styleFor(mNpm);
      if (st !== styleFor(p.npm)) entry.s = st;
      if (mApi !== api) entry.api = mApi;
      if (m.release_date) entry.rd = m.release_date;
      models.push(entry);
    }
    if (!models.length) continue;
    models.sort((a, b) => (b.rd || "").localeCompare(a.rd || "") || a.name.localeCompare(b.name));
    providers.push({ id, name: p.name || id, api, s: styleFor(p.npm), doc: p.doc || null, models });
  }
  providers.sort((a, b) => a.name.localeCompare(b.name));
  return { at: Date.now(), providers };
}

/** Where and how to send a request for one model. */
export function endpoint(provider, model) {
  const style = model.s || provider.s || "chat";
  const api = String(model.api || provider.api).replace(/\/+$/, "");
  const auth = style === "anthropic" ? "x-api-key" : style === "google" ? "x-goog-api-key" : "bearer";
  let url;
  if (style === "chat") url = `${api}/chat/completions`;
  else if (style === "responses") url = `${api}/responses`;
  else if (style === "anthropic") url = `${api}/messages`;
  else url = `${api}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`;
  return { style, url, auth };
}

/** Every host a provider's requests may go to; its API key is only ever sent to these. */
export function hostsFor(provider) {
  const hosts = new Set();
  for (const u of [provider.api, ...provider.models.map((m) => m.api).filter(Boolean)]) {
    try {
      hosts.add(new URL(u).host);
    } catch {
      /* ignore */
    }
  }
  return [...hosts];
}

/** A user-defined OpenAI-compatible provider (Ollama, LM Studio, vLLM…). */
export function customProvider({ id, name, api, models }) {
  return {
    id,
    name: name || "Custom",
    api: String(api).replace(/\/+$/, ""),
    s: "chat",
    custom: true,
    models: (models || []).map((m) => ({ id: m, name: m, in: 0, out: 0, cr: 0, ctx: 0, max: 0, nc: 1 })),
  };
}
