// Paradigm service worker — offline-first app shell (PRD §2 goal 3, web analog).
// Cache name is bumped by the content-pack version baked in at registration time
// (?v= query param), so a new content push refreshes the cache. SHELL_REV bumps
// it for app-shell changes that don't come with new content.
const VERSION = new URL(self.location).searchParams.get("v") || "0";
const SHELL_REV = 2; // 2: Mystico sting (js/sting.js)
const CACHE = `paradigm-v${VERSION}-s${SHELL_REV}`;

const SHELL = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/sting.js",
  "./js/analytics.js",
  "./js/fsrs.js",
  "./js/levels.js",
  "./js/app.js",
  "./data/content.js",
  "./data/manifest.json",
  "./manifest.webmanifest",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first with cache fallback: app-code fixes reach clients immediately
// when online (a cache-first shell would pin stale css/js until a version bump);
// the cache keeps the whole app working offline.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) return;
  // The sting's films stream with Range requests (206s can't be cached); left to
  // the network, so offline the film fails and the sting skips straight to the app.
  if (e.request.headers.has("range")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((hit) =>
          // Offline links with a query (?sting=on, campaign tags) open the cached shell.
          hit || (e.request.mode === "navigate" ? caches.match("./index.html") : hit)
        )
      )
  );
});
