/**
 * PWA (installable app + offline caching) is switched off for now (27 Oct 2026): the caching service worker
 * served stale pages and scripts. With this off, the site registers no worker, removes any worker and cache a
 * browser still has, links no web app manifest and hides "Get the app". Flip to true (and restore
 * pwa/sw-cached.js as public/sw.js) to turn it back on.
 */
export const PWA_ENABLED = false;
