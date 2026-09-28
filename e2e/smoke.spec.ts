import { expect, test } from "@playwright/test";

test("homepage renders with restored styles", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.ok()).toBe(true);
  await expect(page.locator(".floating-nav").first()).toBeAttached();
  const pos = await page
    .locator(".floating-nav")
    .first()
    .evaluate((el) => getComputedStyle(el).position);
  expect(pos).toBe("fixed");
});

test("journal route responds", async ({ page }) => {
  const res = await page.goto("/journal");
  expect(res?.status()).toBeLessThan(500);
});
