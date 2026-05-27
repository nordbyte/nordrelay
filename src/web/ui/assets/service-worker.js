const CACHE_NAME = "nordrelay-webui-__NORDRELAY_WEBUI_CACHE_VERSION__";
const ASSET_VERSION = "__NORDRELAY_WEBUI_ASSET_VERSION__";
const STATIC_ASSETS = [
  "/",
  `/assets/${ASSET_VERSION}/dashboard.css`,
  `/assets/${ASSET_VERSION}/dashboard.js`,
  "/assets/logo.png",
  "/assets/favicon.png",
  "/favicon.ico",
  "/manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || request.headers.get("accept") === "text/event-stream") {
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }
  if (/^\/assets\/[^/]+\/dashboard\.(?:css|js)$/.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
