const CACHE = 'customer-splitter-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'worker.js', 'manifest.webmanifest', 'icon.svg', 'vendor/exceljs.min.js', 'vendor/jszip.min.js'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request)));
});
