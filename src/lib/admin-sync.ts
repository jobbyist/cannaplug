import { useEffect, useRef } from "react";

/**
 * Keeps several /admin tabs in step. When one tab changes something (a till sale, a stock receipt, a product
 * edit, an order moving on), it tells the other tabs, and they reload that data quietly in the background:
 * no sign-in screen, no "Loading…" flash, and nothing typed on screen (a basket, a search, a form) is lost.
 * Only a topic name crosses between tabs, never data. Browsers without BroadcastChannel simply don't sync.
 */
export type AdminTopic = "stock" | "products" | "orders" | "payments" | "ids" | "any";

const CHANNEL = "cannaplug-admin";

function channel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

/** Tell the other open admin tabs that `topic` changed. */
export function notifyAdminTabs(topic: AdminTopic): void {
  const ch = channel();
  if (!ch) return;
  ch.postMessage({ topic, at: Date.now() });
  ch.close();
}

/** Run `onChange` when another tab reports a change to one of `topics` (debounced, so bursts reload once). */
export function useAdminTabSync(topics: AdminTopic[], onChange: () => void, delayMs = 400): void {
  const handler = useRef(onChange);
  handler.current = onChange;
  const key = topics.join(",");
  useEffect(() => {
    const ch = channel();
    if (!ch) return;
    const wanted = new Set(key.split(","));
    let timer: ReturnType<typeof setTimeout> | null = null;
    ch.onmessage = (e: MessageEvent<{ topic?: string }>) => {
      const t = e.data?.topic;
      if (!t || !(wanted.has(t) || wanted.has("any") || t === "any")) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => handler.current(), delayMs);
    };
    return () => {
      if (timer) clearTimeout(timer);
      ch.close();
    };
  }, [key, delayMs]);
}

/** The admin section shown in this tab, kept in the address (#pos) so a reload or a copied link opens it. */
export function sectionFromHash(hash: string, fallback = "overview"): string {
  const s = hash.replace(/^#/, "").trim();
  return /^[a-z][a-z-]{1,30}$/.test(s) ? s : fallback;
}
