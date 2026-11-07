// On-device storage (IndexedDB): chats, the token ledger and small settings.
const DB = "opencode-pixel";
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("chats", { keyPath: "id" });
      db.createObjectStore("usage", { keyPath: "id", autoIncrement: true });
      db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => (result = r.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const chats = {
  all: () => tx("chats", "readonly", (s) => s.getAll()),
  get: (id) => tx("chats", "readonly", (s) => s.get(id)),
  put: (chat) => tx("chats", "readwrite", (s) => s.put(chat)),
  delete: (id) => tx("chats", "readwrite", (s) => s.delete(id)),
  clear: () => tx("chats", "readwrite", (s) => s.clear()),
};

export const usage = {
  all: () => tx("usage", "readonly", (s) => s.getAll()),
  add: (entry) => tx("usage", "readwrite", (s) => s.add(entry)),
  clear: () => tx("usage", "readwrite", (s) => s.clear()),
};

export const kv = {
  get: (k) => tx("kv", "readonly", (s) => s.get(k)),
  set: (k, v) => tx("kv", "readwrite", (s) => s.put(v, k)),
  delete: (k) => tx("kv", "readwrite", (s) => s.delete(k)),
};

/** Everything except API keys, for backup. */
export async function exportAll() {
  return {
    app: "opencode-pixel",
    version: 1,
    exportedAt: new Date().toISOString(),
    chats: await chats.all(),
    usage: await usage.all(),
    budgets: (await kv.get("budgets")) || null,
    custom: (await kv.get("custom")) || [],
  };
}

export async function importAll(data) {
  if (data?.app !== "opencode-pixel") throw new Error("That isn't an opencode·pixel backup");
  for (const c of data.chats || []) await chats.put(c);
  const have = new Set((await usage.all()).map((u) => `${u.time}|${u.providerID}|${u.modelID}`));
  for (const u of data.usage || []) {
    if (have.has(`${u.time}|${u.providerID}|${u.modelID}`)) continue;
    const { id, ...rest } = u;
    await usage.add(rest);
  }
  if (data.budgets) await kv.set("budgets", data.budgets);
  if (data.custom?.length) await kv.set("custom", data.custom);
  return (data.chats || []).length;
}
