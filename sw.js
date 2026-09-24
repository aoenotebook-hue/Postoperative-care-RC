/* Service worker for the post-operative care app.
   Purpose: make the app installable ("Add to Home Screen") and keep it usable
   with a poor or absent connection. Guidance changes matter clinically, so
   pages and content are always fetched from the network first and the cache is
   only a fallback — never a source of stale instructions while online. */

// Cache keys are process-wide within an origin (the Cache Storage API has no
// per-app or per-path scoping), so if this app ever ends up sharing an origin
// with another app, a version-bump cleanup that isn't scoped to this app's own
// prefix would delete that other app's offline cache too. Every key this
// service worker creates or removes MUST start with CACHE_PREFIX.
const CACHE_PREFIX = 'shouldercare-';
const CACHE = CACHE_PREFIX + 'v1';
const CORE = ['./', './index.html', './manifest.json', './images/icon-192.png', './images/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE))
      .catch(() => { /* offline on first load — the runtime handler will fill the cache later */ })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function cachePut(request, response){
  if(response && response.ok && response.type === 'basic'){
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if(request.method !== 'GET') return;

  const url = new URL(request.url);
  if(url.origin !== self.location.origin) return;      // check-in uploads and outside links: straight to the network
  if(url.pathname.endsWith('.mp4')) return;            // videos use range requests — leave them to the browser

  const isPage = request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');

  if(isPage){
    // Network-first: patients always get the latest guidance when they have a signal.
    event.respondWith(
      fetch(request)
        .then(res => cachePut(request, res))
        .catch(() => caches.match(request).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // Images, icons, manifest: serve from cache for speed, refresh in the background.
  event.respondWith(
    caches.match(request).then(hit => {
      const network = fetch(request).then(res => cachePut(request, res)).catch(() => hit);
      return hit || network;
    })
  );
});
