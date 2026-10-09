// Service worker: offline copy of the app and last-seen data, plus push notifications.
const VERSION = "v1";
const SHELL = ["/", "/app.js", "/styles.css", "/manifest.webmanifest", "/icons/icon-192.png"];
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL_CACHE, DATA_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // API reads: network first, fall back to the last copy so the plan still opens offline.
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || Response.json({ error: "You're offline." }, { status: 503 }))),
    );
    return;
  }

  // App shell and fonts: serve cached copy right away, refresh it in the background.
  const sameOrigin = url.origin === location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !isFont) return;
  const key = req.mode === "navigate" ? "/" : req;
  e.respondWith(
    caches.match(key).then((cached) => {
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok || res.type === "opaque") {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(key, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});

self.addEventListener("push", (e) => {
  let msg = { title: "Plan", body: "" };
  try {
    msg = e.data.json();
  } catch {}
  e.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      tag: msg.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: msg.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", location.origin);
  const taskId = url.searchParams.get("task");
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const client = list.find((c) => new URL(c.url).origin === location.origin);
      if (client) {
        if (taskId) client.postMessage({ type: "open-task", id: taskId });
        return client.focus();
      }
      return self.clients.openWindow(url.href);
    }),
  );
});
