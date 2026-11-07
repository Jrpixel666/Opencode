// Request bodies and streaming parsers for the four API styles (see catalog.js).
// Pure functions: no network here, so they can be unit-tested.

/** messages: [{ role: "user"|"assistant", text, images: [dataURL] }] */
export function buildRequest(style, model, messages, { system = "" } = {}) {
  const headers = { "content-type": "application/json", accept: "text/event-stream" };
  let body;
  if (style === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: model.id,
      max_tokens: Math.min(model.max || 8192, 32000),
      stream: true,
      messages: messages.map((m) => ({
        role: m.role,
        content: [...(m.images || []).map((url) => ({ type: "image", source: { type: "base64", ...splitDataUrl(url) } })), ...(m.text ? [{ type: "text", text: m.text }] : [])],
      })),
    };
    if (system) body.system = system;
  } else if (style === "responses") {
    body = {
      model: model.id,
      stream: true,
      store: false,
      input: messages.map((m) => ({
        role: m.role,
        content: [
          ...(m.images || []).map((url) => ({ type: "input_image", image_url: url })),
          ...(m.text ? [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.text }] : []),
        ],
      })),
    };
    if (system) body.instructions = system;
    if (model.r) body.reasoning = { summary: "auto" };
  } else if (style === "google") {
    body = {
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [...(m.images || []).map((url) => { const d = splitDataUrl(url); return { inline_data: { mime_type: d.media_type, data: d.data } }; }), ...(m.text ? [{ text: m.text }] : [])],
      })),
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (model.r) body.generationConfig = { thinkingConfig: { includeThoughts: true } };
  } else {
    body = {
      model: model.id,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...messages.map((m) => ({
          role: m.role,
          content: m.images?.length ? [...(m.text ? [{ type: "text", text: m.text }] : []), ...m.images.map((url) => ({ type: "image_url", image_url: { url } }))] : m.text || "",
        })),
      ],
    };
  }
  return { headers, body: JSON.stringify(body) };
}

export function splitDataUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url || "");
  return m ? { media_type: m[1], data: m[2] } : { media_type: "image/jpeg", data: "" };
}

/**
 * Incremental parser for a streamed reply. Feed it raw text chunks; it returns events:
 *   { type: "text", delta } | { type: "reasoning", delta } | { type: "usage", usage }
 *   | { type: "error", message } | { type: "done" }
 * usage = { input, output, reasoning, cacheRead, cacheWrite } (input excludes cached tokens;
 * output includes reasoning tokens, since both are billed as output).
 */
export function createParser(style) {
  let buf = "";
  let event = "";
  let data = [];
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let sawUsage = false;

  const handle = (ev, raw, out) => {
    if (raw === "[DONE]") return out.push({ type: "done" });
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      return;
    }
    if (j.error || ev === "error") {
      const e = j.error || j;
      return out.push({ type: "error", message: e.message || (typeof e === "string" ? e : JSON.stringify(e)) });
    }
    if (style === "anthropic") {
      const t = j.type || ev;
      if (t === "message_start" && j.message?.usage) {
        const u = j.message.usage;
        usage.input = u.input_tokens || 0;
        usage.cacheRead = u.cache_read_input_tokens || 0;
        usage.cacheWrite = u.cache_creation_input_tokens || 0;
        usage.output = u.output_tokens || 0;
        sawUsage = true;
      } else if (t === "content_block_delta") {
        if (j.delta?.type === "text_delta") out.push({ type: "text", delta: j.delta.text });
        else if (j.delta?.type === "thinking_delta") out.push({ type: "reasoning", delta: j.delta.thinking });
      } else if (t === "message_delta" && j.usage) {
        usage.output = j.usage.output_tokens ?? usage.output;
        if (j.usage.input_tokens) usage.input = j.usage.input_tokens;
        sawUsage = true;
        out.push({ type: "usage", usage: { ...usage } });
      } else if (t === "message_stop") out.push({ type: "done" });
    } else if (style === "responses") {
      const t = j.type || ev;
      if (t === "response.output_text.delta") out.push({ type: "text", delta: j.delta });
      else if (t === "response.reasoning_summary_text.delta" || t === "response.reasoning_text.delta") out.push({ type: "reasoning", delta: j.delta });
      else if (t === "response.completed" || t === "response.incomplete") {
        const u = j.response?.usage;
        if (u) {
          const cached = u.input_tokens_details?.cached_tokens || 0;
          Object.assign(usage, { input: (u.input_tokens || 0) - cached, cacheRead: cached, output: u.output_tokens || 0, reasoning: u.output_tokens_details?.reasoning_tokens || 0 });
          sawUsage = true;
          out.push({ type: "usage", usage: { ...usage } });
        }
        out.push({ type: "done" });
      } else if (t === "response.failed") {
        out.push({ type: "error", message: j.response?.error?.message || "The request failed" });
      }
    } else if (style === "google") {
      for (const part of j.candidates?.[0]?.content?.parts || []) {
        if (!part.text) continue;
        out.push({ type: part.thought ? "reasoning" : "text", delta: part.text });
      }
      const u = j.usageMetadata;
      if (u) {
        const cached = u.cachedContentTokenCount || 0;
        Object.assign(usage, { input: (u.promptTokenCount || 0) - cached, cacheRead: cached, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), reasoning: u.thoughtsTokenCount || 0 });
        sawUsage = true;
        out.push({ type: "usage", usage: { ...usage } });
      }
    } else {
      const d = j.choices?.[0]?.delta;
      if (d) {
        const r = d.reasoning_content ?? d.reasoning;
        if (typeof r === "string" && r) out.push({ type: "reasoning", delta: r });
        if (typeof d.content === "string" && d.content) out.push({ type: "text", delta: d.content });
      }
      const u = j.usage;
      if (u && (u.prompt_tokens || u.completion_tokens)) {
        const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
        Object.assign(usage, { input: (u.prompt_tokens || 0) - cached, cacheRead: cached, output: u.completion_tokens || 0, reasoning: u.completion_tokens_details?.reasoning_tokens || 0 });
        sawUsage = true;
        out.push({ type: "usage", usage: { ...usage } });
      }
    }
  };

  return {
    push(chunk) {
      const out = [];
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line === "") {
          if (data.length) handle(event, data.join("\n"), out);
          event = "";
          data = [];
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("event:")) event = line.slice(6).trim();
      }
      return out;
    },
    /** Call when the stream ends: flushes a final event that had no trailing blank line. */
    end() {
      const out = [];
      if (buf.trim().startsWith("data:")) data.push(buf.trim().slice(5).replace(/^ /, ""));
      if (data.length) handle(event, data.join("\n"), out);
      buf = "";
      data = [];
      return out;
    },
    usage: () => (sawUsage ? { ...usage } : null),
  };
}

/** Readable message from an HTTP error body. */
export function errorMessage(status, text) {
  let msg = "";
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0]?.error : j.error ?? j;
    msg = typeof e === "string" ? e : e?.message || j.message || "";
  } catch {
    msg = String(text || "").slice(0, 300);
  }
  const hint = { 401: "The API key was rejected.", 403: "This key isn't allowed to use that model.", 402: "Out of credit.", 404: "Model not found at this provider.", 429: "Rate limited or out of quota — try again shortly." }[status];
  return [hint, msg].filter(Boolean).join(" ") || `HTTP ${status}`;
}

/** Rough token count when a provider doesn't report usage (≈ 4 characters per token). */
export const estimateTokens = (text) => Math.ceil(String(text || "").length / 4);
