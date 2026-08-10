/*
 * Service worker: app-shell caching so capture opens with no signal.
 *
 * Weigh-in POSTs are deliberately NOT handled here. They are queued in
 * IndexedDB by the app itself, which survives the worker being evicted and
 * gives the collector visible control over what has and has not synced. A
 * background-sync replay of opaque POSTs would hide that.
 *
 * CACHING STRATEGY — the previous version was cache-first for every same-origin
 * GET, which bricked the app on every deploy:
 *
 *   1. index.html was served from cache forever, so a new build was never seen.
 *   2. That stale HTML referenced hashed bundles which no longer existed, and
 *      the 404 fallback returned index.html *in place of the JavaScript*. The
 *      browser refused to execute HTML as a module, so the app hung on its boot
 *      screen — a field phone that could no longer record a weigh-in.
 *
 * So the two kinds of request are now treated differently:
 *
 *   - HTML/navigation: network-first. The network copy wins when reachable, and
 *     the cache is only a fallback for genuinely being offline. This is what
 *     makes an update reach an installed phone.
 *   - Hashed build assets: cache-first, which is safe precisely because the
 *     filename contains a content hash — new content always means a new URL.
 *
 * A missing asset must surface as an error, never as a fallback document.
 */

// Bumping this name purges the poisoned caches left by the previous strategy.
const CACHE = "proofchain-capture-v2";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Vite emits content-hashed files under /assets/; the URL changes when the bytes do. */
function isImmutableAsset(url) {
  return url.pathname.startsWith("/assets/");
}

function isHtmlRequest(request, url) {
  return (
    request.mode === "navigate" ||
    request.destination === "document" ||
    url.pathname === "/" ||
    url.pathname.endsWith(".html")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache API traffic: a stale weigh-in response would be a lie.
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (isHtmlRequest(request, url)) {
    // Network-first: an update must be able to reach a phone that already has
    // the app installed. Cache is the offline fallback, not the default answer.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(() => caches.match("/index.html").then((c) => c ?? Response.error())),
    );
    return;
  }

  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            // Only store real successes. Caching a 404 here would make a broken
            // deploy permanent, which is the failure this worker just caused.
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Everything else (icons, manifest): stale-while-revalidate, and on a miss let
  // the real network result through — including its error status. Substituting a
  // document for a failed asset is what produced "HTML is not valid JavaScript".
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});
