#!/usr/bin/env node
// opencode-pixel bridge: serves the phone app, handles login, and proxies to `opencode serve`.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { config } from "./config.js";
import { currentUser, login, logoutCookie } from "./auth.js";
import { oc, upstreamHeaders, upstreamUrl } from "./opencode.js";
import { balanceReport, readBudgets, writeBudgets, readAuthFile, maskKey } from "./balances.js";
import { startMock } from "./mock.js";

const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, "package.json"), "utf8")).version;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), geolocation=(), microphone=(self)",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(res, status, data, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit = 2_000_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

// ---- static files ---------------------------------------------------------------------

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || !path.extname(rel)) rel = "/index.html"; // single-page app
  const file = path.resolve(config.publicDir, "." + rel);
  if (!file.startsWith(config.publicDir + path.sep)) return json(res, 403, { error: "forbidden" });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: "not found" });
    const ext = path.extname(file);
    // HTML and the service worker must revalidate so updates reach the phone.
    const fresh = ext === ".html" || rel === "/sw.js" || ext === ".webmanifest";
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": st.size,
      "cache-control": fresh ? "no-cache" : "public, max-age=3600",
      ...SECURITY_HEADERS,
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---- proxy to opencode ----------------------------------------------------------------

async function proxy(req, res, upstreamPath) {
  const headers = upstreamHeaders();
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (req.headers.accept) headers.accept = req.headers.accept;
  const ctrl = new AbortController();
  res.on("close", () => ctrl.abort());
  let up;
  try {
    up = await fetch(upstreamUrl(upstreamPath), {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Readable.toWeb(req),
      duplex: "half",
      signal: ctrl.signal,
    });
  } catch (e) {
    if (ctrl.signal.aborted) return;
    return json(res, 502, { error: `Can't reach opencode at ${config.opencode.url}. Is \`opencode serve\` running?`, detail: e.cause?.code || e.message });
  }
  const out = { ...SECURITY_HEADERS, "cache-control": "no-store" };
  // Not content-length: fetch transparently decompresses, so the upstream length would be wrong.
  if (up.headers.get("content-type")) out["content-type"] = up.headers.get("content-type");
  if ((out["content-type"] || "").includes("text/event-stream")) out["x-accel-buffering"] = "no"; // keep reverse proxies from buffering events
  if (up.status === 401) {
    return json(res, 502, { error: "opencode rejected the bridge's credentials. Check OPENCODE_SERVER_PASSWORD." });
  }
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  Readable.fromWeb(up.body)
    .on("error", () => res.end())
    .pipe(res);
}

// ---- API routes -----------------------------------------------------------------------

async function api(req, res, url) {
  const p = url.pathname;

  if (p === "/api/health") return json(res, 200, { ok: true, version: VERSION });

  if (p === "/api/login" && req.method === "POST") {
    const r = login(req, await readJson(req, 10_000));
    if (r.error) return json(res, r.status, { error: r.error });
    return json(res, 200, { user: { name: r.user.u, since: r.user.iat, expires: r.user.exp } }, { "set-cookie": r.setCookie });
  }

  const user = currentUser(req);
  if (!user) return json(res, 401, { error: "Not logged in." });

  // Cross-site request guard for state-changing calls (cookie is SameSite=Strict too).
  if (req.method !== "GET" && req.headers["x-ocb"] !== "1") return json(res, 403, { error: "missing x-ocb header" });

  if (p === "/api/logout" && req.method === "POST") return json(res, 200, { ok: true }, { "set-cookie": logoutCookie() });

  if (p === "/api/me") {
    let opencode = { url: config.opencode.url, reachable: false };
    try {
      const [paths, project] = await Promise.all([oc("GET", "/path"), oc("GET", "/project/current").catch(() => null)]);
      opencode = { url: config.opencode.url, reachable: true, directory: paths?.directory, worktree: paths?.worktree, config: paths?.config, project };
    } catch (e) {
      opencode.error = e.status ? `HTTP ${e.status}` : e.cause?.code || e.message;
    }
    return json(res, 200, {
      user: { name: user.u, since: user.iat, expires: user.exp },
      bridge: { version: VERSION, demo: config.demo, authFile: config.authFile, authFileFound: fs.existsSync(config.authFile) },
      opencode,
    });
  }

  if (p === "/api/accounts") {
    const auth = readAuthFile();
    const [list, methods] = await Promise.all([oc("GET", "/provider").catch(() => null), oc("GET", "/provider/auth").catch(() => ({}))]);
    const names = Object.fromEntries((list?.all || []).map((x) => [x.id, x.name]));
    const connected = list?.connected || [];
    const ids = new Set([...Object.keys(auth), ...connected]);
    const accounts = [...ids].map((id) => {
      const a = auth[id];
      return {
        id,
        name: names[id] || id,
        connected: connected.includes(id),
        type: a?.type || "env",
        hint: a?.type === "api" ? maskKey(a.key) : a?.type === "wellknown" ? maskKey(a.token) : null,
        expires: a?.type === "oauth" ? a.expires : null,
        enterpriseUrl: a?.enterpriseUrl || null,
      };
    });
    const available = (list?.all || [])
      .map((x) => ({ id: x.id, name: x.name, env: x.env, methods: methods?.[x.id] || [{ type: "api", label: "API key" }] }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return json(res, 200, { accounts, available });
  }

  if (p === "/api/balances") return json(res, 200, await balanceReport({ force: url.searchParams.get("force") === "1" }));

  if (p === "/api/budgets") {
    if (req.method === "PUT") return json(res, 200, writeBudgets(await readJson(req, 100_000)));
    return json(res, 200, readBudgets());
  }

  if (p.startsWith("/api/oc/")) return proxy(req, res, p.slice("/api/oc".length) + url.search);

  json(res, 404, { error: "unknown endpoint" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    serveStatic(req, res, url.pathname);
  } catch (e) {
    const status = e.status && e.status < 600 ? (e.status >= 500 ? 502 : e.status) : 500;
    if (!res.headersSent) json(res, status, { error: e.message, detail: e.data });
    else res.end();
  }
});

if (config.demo) config.opencode.url = await startMock();

server.listen(config.port, config.host, () => {
  const where = `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;
  console.log(`\n  opencode-pixel ${VERSION}  →  ${where}`);
  console.log(`  opencode server: ${config.demo ? "built-in demo" : config.opencode.url}`);
  console.log(`  login: ${config.username} / ${config.generatedPassword ? config.password + "  (generated; set OCB_PASSWORD to change)" : "(from OCB_PASSWORD)"}\n`);
});
