// Runtime configuration, read once from the environment (and an optional .env file).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader so the project needs no dependencies.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(root, ".env"));

const env = process.env;
const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const dataDir = path.resolve(env.OCB_DATA_DIR || path.join(root, env.OCB_DEMO === "1" ? "data-demo" : "data"));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

// A stable secret for signing login sessions. Persisted so logins survive restarts.
function secret() {
  if (env.OCB_SECRET) return env.OCB_SECRET;
  const file = path.join(dataDir, ".secret");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  return fs.readFileSync(file, "utf8").trim();
}

let password = env.OCB_PASSWORD;
let generatedPassword = false;
if (!password) {
  const file = path.join(dataDir, ".password");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(9).toString("base64url"), { mode: 0o600 });
  password = fs.readFileSync(file, "utf8").trim();
  generatedPassword = true;
}

export const config = {
  root,
  publicDir: path.join(root, "public"),
  dataDir,
  host: env.OCB_HOST || "127.0.0.1",
  port: Number(env.OCB_PORT || 7878),
  username: env.OCB_USERNAME || "me",
  password,
  generatedPassword,
  secret: secret(),
  sessionDays: Number(env.OCB_SESSION_DAYS || 30),
  // Set when the bridge is served over HTTPS (e.g. behind Tailscale Serve or Caddy).
  secureCookies: env.OCB_SECURE_COOKIES === "1",
  demo: env.OCB_DEMO === "1",
  opencode: {
    url: (env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/$/, ""),
    username: env.OPENCODE_SERVER_USERNAME || "opencode",
    password: env.OPENCODE_SERVER_PASSWORD || "",
    directory: env.OPENCODE_DIRECTORY || "",
  },
  authFile: env.OPENCODE_AUTH_FILE ? env.OPENCODE_AUTH_FILE.replace(/^~(?=\/|$)/, os.homedir()) : path.join(dataHome, "opencode", "auth.json"),
};
