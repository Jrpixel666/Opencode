// Fetch helpers. Everything goes through the bridge, which holds the opencode credentials.
const listeners = new Set();
export const onUnauthorized = (fn) => listeners.add(fn);

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "x-ocb": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== "/api/login") listeners.forEach((fn) => fn());
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = data?.error || data?.data?.message || data?.message || (Array.isArray(data?.errors) && data.errors[0]?.message) || `HTTP ${res.status}`;
    throw Object.assign(new Error(typeof msg === "string" ? msg : JSON.stringify(msg)), { status: res.status, data });
  }
  return data;
}

export const oc = (path, opts) => api(`/api/oc${path}`, opts);
