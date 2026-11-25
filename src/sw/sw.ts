// The page's service worker (dist/sw.js, registered by src/app/map-cache.ts): it keeps the base map on this device.
// Only swisstopo's map files go through it: vector tiles, satellite photos (SWISSIMAGE), and the styles, fonts and
// icons that come with them. Every other request, the app's own files above all, is left to the browser as if
// there were no service worker, so a new version of the site is never held back by it.
//
// Tiles: from the cache when there (no network at all), fetched again in the background once a week old, so
// that coming back to a place draws it at once, also offline. Styles, fonts and icons: from the cache, refreshed in
// the background on every use. Each cache keeps a limited number of files; the oldest go first.
// The browser may still clear all of it (Safari does after some weeks without a visit): it is only a speed-up.

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

/** Raise to start over with empty caches (the old ones are deleted when this worker takes over). */
const VERSION = 1;
const PREFIX = 'santiago-map-';
interface Store { name: string; max: number; maxAgeMs: number }
/** Vector tiles: up to ~0.5 MB each in city centres as stored (the cache keeps them unzipped). */
const VECTOR: Store = { name: `${PREFIX}vector-v${VERSION}`, max: 400, maxAgeMs: 7 * 864e5 };
/** Satellite photos: ~20–40 kB each. */
const RASTER: Store = { name: `${PREFIX}raster-v${VERSION}`, max: 3000, maxAgeMs: 7 * 864e5 };
/** Styles, TileJSON, fonts (glyph ranges) and icon sheets: refreshed in the background on every use. */
const STATIC: Store = { name: `${PREFIX}static-v${VERSION}`, max: 400, maxAgeMs: 0 };
const STORES = [VECTOR, RASTER, STATIC];

/** Which cache a request belongs in, or null to leave it alone. */
function storeFor(url: URL): Store | null {
  if (/^vectortiles\d*\.geo\.admin\.ch$/.test(url.hostname)) {
    if (/^\/tiles\/[^/]+\/[^/]+\/\d+\/\d+\/\d+\.pbf$/.test(url.pathname)) return VECTOR;
    if (/^\/(styles|fonts|tiles)\//.test(url.pathname)) return STATIC;
    return null;
  }
  if (url.hostname === 'wmts.geo.admin.ch' && url.pathname.startsWith('/1.0.0/ch.swisstopo.swissimage/')) return RASTER;
  return null;
}
/** The same file from vectortiles0–4 or vectortiles is one entry. */
const cacheKey = (url: URL) => url.href.replace(/^https:\/\/vectortiles\d\./, 'https://vectortiles.');

self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set(STORES.map((s) => s.name));
    for (const name of await caches.keys()) if (name.startsWith(PREFIX) && !keep.has(name)) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  let url: URL;
  try { url = new URL(req.url); } catch (e) { return; }
  const store = storeFor(url);
  if (!store) return; // not ours: the browser handles it as without a service worker
  event.respondWith(respond(event, req, store, cacheKey(url)));
});

async function respond(event: FetchEvent, req: Request, store: Store, key: string): Promise<Response> {
  let cache: Cache | null = null, hit: Response | undefined;
  try {
    cache = await caches.open(store.name);
    hit = await cache.match(key);
  } catch (e) { /* no storage (private browsing, quota): straight to the network */ }
  if (hit) {
    // stale: still answered from the cache at once, and fetched again for next time
    if (age(hit) >= store.maxAgeMs) event.waitUntil(refresh(req, store, key).catch(() => {}));
    return hit;
  }
  // req carries the map's AbortSignal: a tile it no longer wants is not fetched to the end
  const res = await fetch(req);
  if (cache && storable(res)) event.waitUntil(put(cache, store, key, res.clone()).catch(() => {}));
  return res;
}

/** Fetches a file again in the background (without the map's signal: nobody waits for it). */
async function refresh(req: Request, store: Store, key: string): Promise<void> {
  const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
  if (storable(res)) await put(await caches.open(store.name), store, key, res);
}

/** A whole, readable answer: not an error, not part of a file, not an opaque one (no size, counted large). */
const storable = (res: Response) => res.status === 200 && (res.type === 'cors' || res.type === 'basic');

/** When this worker stored the answer. Not the server's Date header: a cross-origin answer does not show it. */
const STORED_AT = 'x-stored-at';
/** How long ago the cached answer was stored (very old if that is not known). */
function age(res: Response): number {
  const t = Number(res.headers.get(STORED_AT));
  return t > 0 ? Date.now() - t : Infinity;
}

// Trimming reads every key of a cache: done on the first new file after the worker starts (the browser stops it
// often), then every so many new files, not on each one
const sinceTrim = new Map<string, number>();
const TRIM_EVERY = 25;
async function put(cache: Cache, store: Store, key: string, res: Response): Promise<void> {
  // the answer as it can be read here (a cross-origin one shows only some headers), with the time it was stored
  const headers = new Headers(res.headers);
  headers.set(STORED_AT, String(Date.now()));
  // the body is kept unzipped: the zipped length and encoding of the original would not match it
  headers.delete('content-length');
  headers.delete('content-encoding');
  const body = await res.arrayBuffer(); // the whole file before anything is stored: a cut-off one is not
  try {
    await cache.put(key, new Response(body, { status: res.status, statusText: res.statusText, headers }));
  } catch (e) {
    // only when storage is full: make room for next time (any other failure leaves the cache as it is)
    if (e instanceof DOMException && e.name === 'QuotaExceededError') await trim(cache, Math.floor(store.max / 2)).catch(() => {});
    return;
  }
  const n = sinceTrim.get(store.name) ?? TRIM_EVERY - 1;
  sinceTrim.set(store.name, n + 1);
  if (n + 1 >= TRIM_EVERY) { sinceTrim.set(store.name, 0); await trim(cache, store.max).catch(() => {}); }
}
/** Deletes the oldest files (keys come back in the order they were stored) down to `keep`. */
async function trim(cache: Cache, keep: number): Promise<void> {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - keep))) await cache.delete(k);
}
