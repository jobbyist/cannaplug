import { expect, test, type Page } from "@playwright/test";

/**
 * Phone layouts (staff feedback, 5 Nov 2026: "the site layouts are a mess on mobile"). Runs in Chromium with phone
 * sizes so CI needs no other browser. These pages render without a backend, so the checks run in CI too.
 */
const PHONES = [
  { name: "small phone", width: 320, height: 568 },
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone 13", width: 390, height: 844 },
  { name: "Pixel 7", width: 412, height: 915 },
];
const PAGES = [
  "/",
  "/shop",
  "/about",
  "/faq",
  "/rewards",
  "/delivery-policy",
  "/account",
  "/account?mode=signup",
];

async function layoutProblems(page: Page, phoneWidth: number) {
  return page.evaluate((expected) => {
    const W = window.innerWidth;
    // On a phone, content wider than the screen makes the browser widen the whole page (and zoom out), so
    // innerWidth grows too: compare against the phone's real width, passed in, not anything the page reports.
    const overflow = Math.max(document.documentElement.scrollWidth, W) - expected;
    const smallInputs = [...document.querySelectorAll("input, select, textarea")]
      .filter((e) => {
        const el = e as HTMLInputElement;
        return (
          el.offsetParent !== null &&
          !["hidden", "checkbox", "radio", "file"].includes(el.type) &&
          parseFloat(getComputedStyle(el).fontSize) < 16
        );
      })
      .map((e) => (e as HTMLElement).id || (e as HTMLInputElement).name || e.tagName);
    return { overflow, smallInputs };
  }, phoneWidth);
}

for (const phone of PHONES) {
  test.describe(phone.name, () => {
    test.use({
      viewport: { width: phone.width, height: phone.height },
      isMobile: true,
      hasTouch: true,
    });

    for (const path of PAGES) {
      test(`${path}: no sideways scrolling, no text box that makes iOS zoom`, async ({ page }) => {
        const res = await page.goto(path);
        expect(res?.status(), path).toBeLessThan(500);
        await page.waitForLoadState("networkidle");
        const r = await layoutProblems(page, phone.width);
        expect(r.overflow, `${path} scrolls sideways by ${r.overflow}px`).toBeLessThanOrEqual(0);
        expect(r.smallInputs, `${path} inputs under 16px`).toEqual([]);
      });
    }

    test("home: the floating nav clears the screen edge and its labels are readable", async ({
      page,
    }) => {
      await page.goto("/");
      const nav = page.locator(".floating-nav").first();
      await expect(nav).toBeVisible();
      const label = await nav
        .locator("a")
        .first()
        .evaluate((a) => parseFloat(getComputedStyle(a).fontSize));
      expect(label).toBeGreaterThanOrEqual(10);
      const box = await nav.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(phone.height);
    });
  });
}
