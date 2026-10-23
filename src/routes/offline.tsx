import { createFileRoute } from "@tanstack/react-router";
import { WifiOff } from "lucide-react";
import logoImage from "@/assets/cannaplug-logo.png";

/**
 * Shown by the service worker when a page is requested with no connection and no saved copy.
 * Self-contained (no data, no member details) so the cached copy is safe for anyone on the device.
 */
export const Route = createFileRoute("/offline")({
  head: () => ({
    meta: [{ title: "You're offline | CannaPlug" }, { name: "robots", content: "noindex" }],
  }),
  component: OfflinePage,
});

function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background px-6 text-center text-foreground">
      <img src={logoImage} alt="CannaPlug" className="h-12 w-auto" />
      <span className="grid h-16 w-16 place-items-center rounded-full bg-primary/10 text-primary">
        <WifiOff size={28} />
      </span>
      <h1 className="font-display text-2xl font-extrabold uppercase">You&apos;re offline</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        We can&apos;t reach CannaPlug right now. Check your connection and try again — pages you
        opened recently still work.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <a
          href=""
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
        >
          Try again
        </a>
        <a href="/" className="rounded-md border border-border px-4 py-2 text-sm font-semibold">
          Home
        </a>
      </div>
      <p className="text-xs text-muted-foreground">
        Shop 002, One On Mutual, Pretoria Central · +27 68 291 2107
      </p>
    </main>
  );
}
