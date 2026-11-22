// Einfacher Service Worker: App-Dateien offline verfügbar (Daten kommen immer live)
const CACHE = 'bridgeinfo-v3';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/geo.js', 'js/bridges.js', 'js/route.js', 'js/alerts.js', 'js/roads.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Netzwerk zuerst, bei Funkloch aus dem Cache
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request)),
  );
});
