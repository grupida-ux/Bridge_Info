// Service Worker: App-Dateien offline verfügbar; Datenkacheln dauerhaft zwischengespeichert
const CACHE = 'bridgeinfo-v5';
const DATA_CACHE = 'bridgeinfo-data'; // Datenkacheln (versioniert über ?v=)
const SHELL = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/geo.js', 'js/bridges.js', 'js/route.js', 'js/alerts.js', 'js/roads.js', 'js/staticdata.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Netzwerk zuerst, bei Funkloch aus dem Cache
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Datenkacheln ändern sich nur mit neuer Version (?v=): zuerst aus dem Cache
  if (url.pathname.includes('/data/') && url.searchParams.has('v')) {
    e.respondWith(caches.open(DATA_CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request)),
  );
});
