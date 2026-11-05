import { lazy, Suspense, useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { isIntroPath } from "@/lib/ask-plug-access";

// Ask The Plug (chat, matching, framer-motion) is only ever shown on the shop pages and the account page, so its
// code is fetched there, after the page has loaded, instead of on every page (admin, checkout, the till…).
const AskThePlug = lazy(() => import("./AskThePlug").then((m) => ({ default: m.AskThePlug })));
const AskThePlugIntro = lazy(() =>
  import("./AskThePlugIntro").then((m) => ({ default: m.AskThePlugIntro })),
);

/** Mounts Ask The Plug once the browser is idle, and only on pages where it can appear. */
export function AskThePlugLoader() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const wanted = isIntroPath(pathname);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!wanted || ready) return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setReady(true), { timeout: 2500 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(() => setReady(true), 1200);
    return () => window.clearTimeout(t);
  }, [wanted, ready]);
  // Once loaded it stays mounted, so moving between shop pages keeps an open chat.
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <AskThePlug />
      <AskThePlugIntro />
    </Suspense>
  );
}
