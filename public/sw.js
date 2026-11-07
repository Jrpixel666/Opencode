// Service worker: makes the app installable, starts instantly from cache, and opens the
// right session when you tap a "reply finished" notification. API calls are never cached.
const VERSION = "ocp-v1";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/js/api.js", "/js/markdown.js", "/js/themes.js", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return; // always live
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (url.origin !== location.origin && !isFont) return;

  // Network first (so updates land), cache as fallback (so it opens offline / on bad signal).
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(e.request)) || (e.request.mode === "navigate" ? caches.match("/index.html") : Response.error())),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const sessionID = e.notification.data?.sessionID;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const c = list[0];
      if (c) {
        c.postMessage({ type: "open-session", sessionID });
        return c.focus();
      }
      return self.clients.openWindow("/?ws=0");
    }),
  );
});
