// Network + key storage. In the Android app every request goes through the native layer,
// which adds the provider's API key (kept encrypted with the Android Keystore; this page never
// sees it) and only for that provider's own hosts. In a desktop browser, used for development
// and tests, it falls back to fetch() with keys held in memory.
const native = window.OpencodeAndroid || null;
export const isNative = Boolean(native);

const pending = new Map();
let seq = 0;

// Callbacks the native layer invokes while a request streams.
window.__ocpNet = {
  head(id, status) {
    pending.get(id)?.onHead?.(status);
  },
  chunk(id, text) {
    pending.get(id)?.onChunk?.(text);
  },
  end(id) {
    const p = pending.get(id);
    pending.delete(id);
    p?.onEnd?.();
  },
  fail(id, message) {
    const p = pending.get(id);
    pending.delete(id);
    p?.onError?.(new Error(message));
  },
};

/**
 * Streams an HTTP request. auth: { provider, style: "bearer"|"x-api-key"|"x-goog-api-key"|"none" }
 * Returns an abort() function.
 */
export function stream({ method = "POST", url, headers = {}, body = null, auth = { style: "none" } }, handlers) {
  const id = `r${++seq}`;
  pending.set(id, handlers);
  if (native) {
    native.request(id, JSON.stringify({ method, url, headers, body, provider: auth.provider || "", auth: auth.style || "none" }));
    return () => {
      native.abort(id);
      const p = pending.get(id);
      pending.delete(id);
      p?.onError?.(Object.assign(new Error("Stopped"), { aborted: true }));
    };
  }
  const ctrl = new AbortController();
  (async () => {
    try {
      const h = { ...headers };
      const key = devKeys[auth.provider]?.key;
      if (auth.style !== "none") {
        if (!key) throw new Error(`No API key for ${auth.provider}`);
        if (auth.style === "bearer") h.authorization = `Bearer ${key}`;
        else h[auth.style] = key;
      }
      const res = await fetch(url, { method, headers: h, body, signal: ctrl.signal });
      window.__ocpNet.head(id, res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        window.__ocpNet.chunk(id, dec.decode(value, { stream: true }));
      }
      window.__ocpNet.end(id);
    } catch (e) {
      window.__ocpNet.fail(id, ctrl.signal.aborted ? "Stopped" : e.message);
    }
  })();
  return () => ctrl.abort();
}

/** Non-streaming convenience: resolves { status, text, json }. */
export function request(opts) {
  return new Promise((resolve, reject) => {
    let status = 0;
    let text = "";
    stream(opts, {
      onHead: (s) => (status = s),
      onChunk: (t) => (text += t),
      onEnd: () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status, text, json });
      },
      onError: reject,
    });
  });
}

// ── keys ──────────────────────────────────────────────────────────────────────────────
const devKeys = {};

/** Saves a key; it will only be sent to `hosts`. Returns "" or an error message. */
export function saveKey(provider, key, hosts) {
  if (native) return native.saveKey(provider, key, JSON.stringify(hosts));
  devKeys[provider] = { key, hosts };
  return "";
}

export function deleteKey(provider) {
  if (native) return native.deleteKey(provider);
  delete devKeys[provider];
}

/** { [provider]: { hint: "sk-o…3456", hosts: [...] } } */
export function keyHints() {
  if (native) {
    try {
      return JSON.parse(native.keyHints() || "{}");
    } catch {
      return {};
    }
  }
  return Object.fromEntries(Object.entries(devKeys).map(([k, v]) => [k, { hint: mask(v.key), hosts: v.hosts }]));
}

export const mask = (k) => (!k || k.length < 8 ? "••••" : `${k.slice(0, 4)}…${k.slice(-4)}`);
