/* Los Banditos SW — network-first so stats are never stale; cache fallback for offline. */
const CACHE = "banditos-v1";
const CORE = ["./", "index.html", "assets/style.css", "assets/app.js",
  "assets/data.js", "assets/extras.js", "assets/icon-192.png", "assets/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Los Banditos", {
    body: d.body || "",
    icon: "assets/icon-192.png",
    badge: "assets/icon-192.png",
    data: { url: d.url || "https://lbffl.com/" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data || {}).url || "https://lbffl.com/";
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus().then(c => c.navigate ? c.navigate(url) : null) : clients.openWindow(url);
  }));
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
