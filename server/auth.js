// Login for the phone app: a password check that issues a signed, HttpOnly session cookie.
import crypto from "node:crypto";
import { config } from "./config.js";

const COOKIE = "ocb_session";

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", config.secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expect = crypto.createHmac("sha256", config.secret).update(body).digest("base64url");
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function currentUser(req) {
  return verify(parseCookies(req)[COOKIE]);
}

function cookie(value, maxAgeSec) {
  const parts = [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
  if (config.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

// Simple per-IP throttle: 8 failed attempts per 10 minutes.
const failures = new Map();
function throttled(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  failures.set(ip, list);
  return list.length >= 8;
}

export function login(req, body) {
  const ip = req.socket.remoteAddress || "?";
  if (throttled(ip)) return { status: 429, error: "Too many attempts. Wait a few minutes." };
  const ok = safeEqual(body?.username ?? "", config.username) & safeEqual(body?.password ?? "", config.password);
  if (!ok) {
    failures.get(ip).push(Date.now());
    return { status: 401, error: "Wrong username or password." };
  }
  failures.delete(ip);
  const now = Date.now();
  const user = { u: config.username, iat: now, exp: now + config.sessionDays * 86_400_000 };
  return { status: 200, user, setCookie: cookie(sign(user), config.sessionDays * 86_400) };
}

export function logoutCookie() {
  return cookie("", 0);
}
