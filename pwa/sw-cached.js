/* CannaPlug service worker (hand-written; no build plugin).
 *
 * - Hashed build assets (/assets/*), icons and Google Fonts: cache-first.
 * - Public pages: network-first with a timeout, falling back to the last copy, then the branded /offline page.
 * - NEVER cached: anything private or live — /admin, /account, /doctor, /member, /checkout, /payment, /verify,
 *   /unsubscribe, /subscribe, /api/*, any Supabase or other third-party request, and any non-GET request.
 *   Those always go straight to the network (the browser handles them as if no worker existed).
 *
 * Bump VERSION to retire every old cache on the next activation.
 */
const VERSION = "v1";
const STATIC_CACHE = `cannaplug-static-${VERSION}`;
const PAGE_CACHE = `cannaplug-pages-${VERSION}`;
const OFFLINE_URL = "/offline";
const PAGE_TIMEOUT_MS = 4000;
const MAX_PAGES = 40;

const PRIVATE_PREFIXES = [
  "/admin",
  "/account",
  "/doctor",
  "/member",
  "/checkout",
  "/payment",
  "/verify",
  "/unsubscribe",
  "/subscribe",
  "/billing",
  "/api/",
  "/_serverFn",
  "/_server",
];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

function isPrivatePath(path) {
  return PRIVATE_PREFIXES.some((p) =>
    p.endsWith("/") ? path.startsWith(p) : path === p || path.startsWith(`${p}/`),
  );
}

/** "network" = do not touch; "static" = cache-first; "page" = network-first. Pure, so it is unit-tested. */
function strategyFor(method, rawUrl, origin, accept) {
  if (method !== "GET") return "network";
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return "network";
  }
  if (url.origin !== origin) return FONT_HOSTS.includes(url.hostname) ? "static" : "network";
  const path = url.pathname;
  if (isPrivatePath(path)) return "network";
  if (url.searchParams.has("token") || url.searchParams.has("code")) return "network";
  if (
    path.startsWith("/assets/") ||
    path.startsWith("/icons/") ||
    /\.(woff2?|png|jpe?g|webp|svg|ico)$/.test(path)
  )
    return "static";
  if (path === "/sw.js" || path === "/manifest.webmanifest") return "network";
  if ((accept || "").includes("text/html")) return "page";
  return "network";
}

/** A response may be stored only if it is a complete, successful, cacheable answer. */
function storable(response) {
  if (!response || !response.ok || response.status !== 200 || response.type === "opaqueredirect")
    return false;
  const cc = (response.headers.get("cache-control") || "").toLowerCase();
  return !cc.includes("no-store") && !cc.includes("private");
}

/** Hashed asset URLs referenced by a page, so /offline renders styled with the network off. */
function assetUrlsIn(html) {
  const out = new Set();
  const re = /(?:href|src)="(\/assets\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) out.add(m[1]);
  return [...out];
}

async function trimPages() {
  const cache = await caches.open(PAGE_CACHE);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await cache.delete(k);
}

async function precacheOffline() {
  const pages = await caches.open(PAGE_CACHE);
  const statics = await caches.open(STATIC_CACHE);
  const res = await fetch(OFFLINE_URL, { cache: "reload", credentials: "omit" });
  if (!res.ok) throw new Error("offline page unavailable");
  const html = await res.clone().text();
  await pages.put(OFFLINE_URL, res);
  await Promise.all(
    [...assetUrlsIn(html), "/icons/icon-192.png"].map((u) => statics.add(u).catch(() => undefined)),
  );
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (storable(res) || res.type === "opaque") await cache.put(request, res.clone());
  return res;
}

async function networkFirst(event) {
  const request = event.request;
  const cache = await caches.open(PAGE_CACHE);
  const network = fetch(request).then(async (res) => {
    if (storable(res)) {
      await cache.put(request, res.clone());
      event.waitUntil(trimPages());
    }
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), PAGE_TIMEOUT_MS));
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
  } catch {
    /* offline: fall through */
  }
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    return await network;
  } catch {
    return (await cache.match(OFFLINE_URL)) || new Response("Offline", { status: 503 });
  }
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("install", (event) => {
    event.waitUntil(precacheOffline());
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        const keep = new Set([STATIC_CACHE, PAGE_CACHE]);
        for (const name of await caches.keys())
          if (name.startsWith("cannaplug-") && !keep.has(name)) await caches.delete(name);
        await self.clients.claim();
      })(),
    );
  });

  self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
  });

  self.addEventListener("fetch", (event) => {
    const r = event.request;
    const kind = strategyFor(r.method, r.url, self.location.origin, r.headers.get("accept"));
    if (kind === "static") event.respondWith(cacheFirst(r));
    else if (kind === "page") event.respondWith(networkFirst(event));
    // "network": no respondWith — the browser fetches it exactly as without a worker.
  });
}

// For unit tests (Node): expose the pure helpers without affecting the browser.
if (typeof module !== "undefined")
  module.exports = { strategyFor, storable, assetUrlsIn, isPrivatePath, PRIVATE_PREFIXES, VERSION };
