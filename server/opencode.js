// Thin client for the opencode HTTP server (`opencode serve`).
import { config } from "./config.js";

export function upstreamHeaders(extra = {}) {
  const h = { ...extra };
  if (config.opencode.password) {
    const token = Buffer.from(`${config.opencode.username}:${config.opencode.password}`).toString("base64");
    h.authorization = `Basic ${token}`;
  }
  return h;
}

export function upstreamUrl(pathAndQuery) {
  const url = new URL(config.opencode.url + pathAndQuery);
  if (config.opencode.directory && !url.searchParams.has("directory")) {
    url.searchParams.set("directory", config.opencode.directory);
  }
  return url;
}

export async function oc(method, path, body) {
  const res = await fetch(upstreamUrl(path), {
    method,
    headers: upstreamHeaders(body === undefined ? {} : { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(`opencode ${method} ${path} → ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
