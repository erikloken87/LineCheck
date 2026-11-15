/* Offline support: app shell + data precached; data refreshed in the background; map tiles cached as viewed. */
const VERSION = "lc-v1";
const SHELL = ["./", "index.html", "css/app.css", "js/app.js", "js/geo.js", "manifest.webmanifest",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css", "vendor/leaflet/images/marker-icon.png",
  "vendor/leaflet/images/marker-icon-2x.png", "vendor/leaflet/images/marker-shadow.png", "vendor/leaflet/images/layers.png",
  "icons/icon-192.png", "icons/icon-512.png"];
const DATA = ["mpa", "lines", "exclusion", "regs", "groundfish", "meta", "coast", "sfbay", "species"].map(f => `data/app/${f}.json`);
const TILE_HOSTS = ["tile.openstreetmap.org", "server.arcgisonline.com"];
const TILE_MAX = 6000;

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll([...SHELL, ...DATA]);
    // species photos
    try {
      const sp = await (await fetch("data/app/species.json")).json();
      const photos = (sp.species || []).map(s => s.photo).filter(Boolean);
      await Promise.allSettled(photos.map(p => c.add(p)));
    } catch (_) { }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== "tiles") await caches.delete(k);
    self.clients.claim();
  })());
});

async function trimTiles() {
  const c = await caches.open("tiles");
  const keys = await c.keys();
  for (let i = 0; i < keys.length - TILE_MAX; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith((async () => {
      const c = await caches.open("tiles");
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const r = await fetch(e.request);
        if (r.ok || r.type === "opaque") { c.put(e.request, r.clone()); if (Math.random() < 0.02) trimTiles(); }
        return r;
      } catch (_) { return new Response("", { status: 504 }); }
    })());
    return;
  }
  if (url.origin !== location.origin) return;
  // data: cache first, refresh in background (stale-while-revalidate)
  if (url.pathname.includes("/data/app/")) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || new Response("null", { headers: { "Content-Type": "application/json" } });
    })());
    return;
  }
  // shell: network first (so updates arrive), cache fallback offline
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    try {
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (_) {
      return (await c.match(e.request, { ignoreSearch: true })) || (await c.match("index.html"));
    }
  })());
});
