/**
 * While the PWA is off: remove any service worker and CannaPlug cache this browser still has. No reload, so an
 * open till (or any form) carries on; the next page load is fresh from the network.
 */
export async function retireServiceWorkers(
  nav: Pick<Navigator, "serviceWorker"> | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator,
  cacheStore: Pick<CacheStorage, "keys" | "delete"> | undefined = typeof caches === "undefined"
    ? undefined
    : caches,
): Promise<number> {
  let removed = 0;
  try {
    if (nav && "serviceWorker" in nav && nav.serviceWorker) {
      for (const reg of await nav.serviceWorker.getRegistrations())
        if (await reg.unregister()) removed += 1;
    }
    if (cacheStore)
      for (const name of await cacheStore.keys())
        if (name.startsWith("cannaplug-")) await cacheStore.delete(name);
  } catch {
    // best effort: the kill-switch /sw.js does the same from the worker side
  }
  return removed;
}
