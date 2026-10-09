// FindMaxxing service worker: the installable app (Session 19) and web push
// (Session 16). Push payloads are { title, body, url, tag } from
// src/server/notifications/push.ts and never contain message text.
//
// Caching, deliberately small:
//   * /_next/static/* and the icons: cache first (their names change when they do).
//   * Saved lists (/saved, /saved/<id>): network first; the last copy you
//     opened is kept so your lists open offline. They are private, so the
//     page asks this worker to forget them when you sign out.
//   * Any other page: network only, with an offline page when there is none.
//   * Nothing else (APIs, server actions, uploads) is ever cached.
const VERSION = "v1";
const STATIC = `fm-static-${VERSION}`;
const PAGES = `fm-pages-${VERSION}`;
// Fetched without cookies: the offline page must not keep anyone's name or avatar.
const SHELL = ["/offline", "/icons/icon-192.png", "/icon.svg"].map((u) => new Request(u, { credentials: "omit" }));

// The offline page has to work with no network at all, so its scripts and
// styles are cached with it (read from its HTML).
async function cacheShell() {
  const cache = await caches.open(STATIC);
  await cache.addAll(SHELL);
  const page = await cache.match("/offline", { ignoreVary: true });
  const html = page ? await page.clone().text() : "";
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]))];
  await cache.addAll(assets);
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("fm-") && k !== STATIC && k !== PAGES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isSavedPage = (url) => url.pathname === "/saved" || /^\/saved\/[0-9a-f-]{36}$/.test(url.pathname);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        // Clone before the page reads the body.
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(STATIC).then((c) => c.put(req, copy)));
        }
        return res;
      })),
    );
    return;
  }

  if (req.mode !== "navigate") return;
  const key = url.origin + url.pathname; // one copy per page, whatever the query
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (isSavedPage(url) && res.ok && !res.redirected) {
          const copy = res.clone();
          event.waitUntil(caches.open(PAGES).then((c) => c.put(key, copy)));
        }
        return res;
      })
      // Next varies pages on its router headers; a copy is a copy here.
      .catch(async () => (isSavedPage(url) && (await caches.match(key, { cacheName: PAGES, ignoreVary: true }))) || (await caches.match("/offline", { ignoreVary: true })) || Response.error()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "forget-private-pages") event.waitUntil(caches.delete(PAGES));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/notifications";
  event.waitUntil(
    self.registration.showNotification(data.title || "FindMaxxing", {
      body: data.body || "You have a new notification",
      tag: data.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/notifications", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (w.url === url && "focus" in w) return w.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
