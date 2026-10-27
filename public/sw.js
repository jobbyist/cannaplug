/* CannaPlug service worker: SWITCHED OFF (27 Oct 2026, owner's request).
 *
 * The caching worker kept serving old copies of pages and scripts, so recent changes seemed to come and go
 * (e.g. the hidden AI chat button reappearing, the new POS category buttons missing). This worker replaces it:
 * it deletes every cache the old worker made and unregisters itself. It has no fetch handler, so every request
 * goes straight to the network. It never reloads an open page (a till sale may be in progress); the next
 * normal page load is simply fresh.
 *
 * To turn the PWA back on: restore pwa/sw-cached.js as public/sw.js and set PWA_ENABLED in src/lib/pwa/flag.ts.
 */
const KILL_SWITCH = true;

async function retire() {
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith("cannaplug-")).map((n) => caches.delete(n)));
  await self.registration.unregister();
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(retire()));
}

if (typeof module !== "undefined") module.exports = { KILL_SWITCH };
