import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  clearInstallPrompt,
  setInstallPrompt,
  type BeforeInstallPromptEvent,
} from "@/lib/pwa/install-prompt";
import { PWA_ENABLED } from "@/lib/pwa/flag";

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

let updateRequested = false;
let reloading = false;

/**
 * Registers /sw.js (production builds only) and shows an "Update available" bar when a new worker is waiting.
 * Reload hands control to the new worker, then refreshes once.
 */
export function PwaRegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!PWA_ENABLED) {
      void retireServiceWorkers();
      return;
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => clearInstallPrompt();
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    if (!("serviceWorker" in navigator) || import.meta.env.DEV) {
      return () => {
        window.removeEventListener("beforeinstallprompt", onPrompt);
        window.removeEventListener("appinstalled", onInstalled);
      };
    }
    // Reload only when the member asked for the update — not when the very first worker takes control.
    const onController = () => {
      if (!updateRequested || reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onController);
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        const watch = (w: ServiceWorker | null) => {
          if (!w) return;
          w.addEventListener("statechange", () => {
            if (w.state === "installed" && navigator.serviceWorker.controller) setWaiting(w);
          });
        };
        if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
        reg.addEventListener("updatefound", () => watch(reg.installing));
      })
      .catch(() => undefined);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      navigator.serviceWorker.removeEventListener("controllerchange", onController);
    };
  }, []);

  if (!waiting || hidden) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-24 z-[60] mx-auto flex max-w-md items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm shadow-lg"
    >
      <RefreshCw size={16} className="text-primary" />
      <span className="flex-1">Update available</span>
      <Button
        size="sm"
        onClick={() => {
          updateRequested = true;
          waiting.postMessage({ type: "SKIP_WAITING" });
        }}
      >
        Reload
      </Button>
      <button
        aria-label="Dismiss"
        onClick={() => setHidden(true)}
        className="text-muted-foreground"
      >
        <X size={16} />
      </button>
    </div>
  );
}
