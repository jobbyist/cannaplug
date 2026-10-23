import { expect, test } from "@playwright/test";

/**
 * PWA: the service worker registers, /offline renders with the network off, and private routes are never
 * served from the cache. Needs a PRODUCTION build (the worker is not registered in dev): run
 * `bash scripts/pwa-e2e.sh`, which builds with the node-server preset and sets PWA_E2E=1.
 */
test.skip(process.env["PWA_E2E"] !== "1", "needs a production build: bash scripts/pwa-e2e.sh");
test.describe.configure({ mode: "serial" });

test("manifest is linked and installable-shaped", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0B3D20");
  const m = await (await request.get("/manifest.webmanifest")).json();
  expect(m).toMatchObject({
    display: "standalone",
    start_url: "/?source=pwa",
    theme_color: "#0B3D20",
  });
  for (const icon of m.icons) expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
});

test("Chrome reports no installability errors (the check Lighthouse's PWA audit used)", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // installability is judged for a page the worker controls
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors" as never)) as {
    installabilityErrors: { errorId: string }[];
  };
  // Playwright contexts are incognito, which Chrome always reports; anything else is a real problem.
  expect(installabilityErrors.filter((e) => e.errorId !== "in-incognito")).toEqual([]);
  const { url, errors } = (await cdp.send("Page.getAppManifest" as never)) as {
    url: string;
    errors: unknown[];
  };
  expect(url).toMatch(/\/manifest\.webmanifest$/);
  expect(errors).toEqual([]);
});

test("private routes are never stored in any cache", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  for (const path of ["/account", "/checkout", "/admin", "/doctor", "/payment/return?order=x"])
    await page.goto(path).catch(() => undefined);
  const stored = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys())
      for (const req of await (await caches.open(name)).keys())
        urls.push(new URL(req.url).pathname);
    return urls;
  });
  for (const p of ["/account", "/checkout", "/admin", "/doctor", "/payment/return"])
    expect(stored, p).not.toContain(p);
  expect(stored.some((u) => u.startsWith("/api/") || u.startsWith("/_serverFn"))).toBe(false);
});

// Last: it stops the server.
test("the service worker registers, controls the page and /offline works with the network off", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const caches = await page.evaluate(() => window.caches.keys());
  expect(caches).toEqual(expect.arrayContaining(["cannaplug-static-v1", "cannaplug-pages-v1"]));

  await page.goto("/about"); // a public page, saved on the way through
  // Chromium's offline emulation does not reach service-worker fetches, so take the server down for real.
  process.kill(Number(process.env["PWA_SERVER_PID"]), "SIGKILL");
  await expect
    .poll(() =>
      fetch("http://127.0.0.1:4173/offline").then(
        () => "up",
        () => "down",
      ),
    )
    .toBe("down");
  await page.goto("/about");
  await expect(page.locator("body")).not.toContainText("You're offline"); // last copy
  await page.goto("/faq?never-visited=1");
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  // styled from cache: the hashed CSS was precached with the offline page
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");
});
