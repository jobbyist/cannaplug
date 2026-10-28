import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { PWA_ENABLED } from "@/lib/pwa/flag";
import { retireServiceWorkers } from "@/components/pwa/retire-service-workers";

const root = join(__dirname, "..", "..");

/** Runs public/sw.js as a browser would, with fake worker globals. */
function runWorker() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const deleted: string[] = [];
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    skipWaiting: vi.fn(),
    registration: { unregister: vi.fn(async () => true) },
    clients: { claim: vi.fn(), matchAll: vi.fn() },
  };
  const caches = {
    keys: async () => ["cannaplug-static-v1", "cannaplug-pages-v1", "other-app"],
    delete: async (n: string) => (deleted.push(n), true),
  };
  runInNewContext(readFileSync(join(root, "public/sw.js"), "utf8"), {
    self,
    caches,
    module: { exports: {} },
  });
  return { handlers, deleted, self };
}

describe("PWA switched off", () => {
  it("is off", () => expect(PWA_ENABLED).toBe(false));

  it("the worker browsers fetch next clears our caches, unregisters itself, handles no requests and reloads nothing", async () => {
    const { handlers, deleted, self } = runWorker();
    expect(handlers["fetch"]).toBeUndefined();
    handlers["install"]!({});
    expect(self.skipWaiting).toHaveBeenCalled();
    let done: Promise<unknown> = Promise.resolve();
    handlers["activate"]!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect(deleted.sort()).toEqual(["cannaplug-pages-v1", "cannaplug-static-v1"]);
    expect(self.registration.unregister).toHaveBeenCalled();
    expect(self.clients.matchAll).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "public/sw.js"), "utf8")).not.toMatch(/navigate\(|reload\(/);
  });

  it("the page removes any registered worker and our caches without reloading", async () => {
    const unregister = vi.fn(async () => true);
    const del = vi.fn(async () => true);
    const removed = await retireServiceWorkers(
      {
        serviceWorker: { getRegistrations: async () => [{ unregister }, { unregister }] },
      } as never,
      { keys: async () => ["cannaplug-static-v1", "x"], delete: del } as never,
    );
    expect(removed).toBe(2);
    expect(del).toHaveBeenCalledWith("cannaplug-static-v1");
    expect(del).not.toHaveBeenCalledWith("x");
  });
});
