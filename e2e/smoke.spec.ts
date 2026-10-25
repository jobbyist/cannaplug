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
  // the Journal reads articles from the database; CI runs this file with a placeholder backend
  test.skip(
    process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] === "ci-placeholder",
    "needs a reachable Supabase (covered by the live suite)",
  );
  const res = await page.goto("/journal");
  expect(res?.status()).toBeLessThan(500);
});

test("static pages respond without a backend", async ({ page }) => {
  for (const path of ["/about", "/faq", "/privacy-policy"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBeLessThan(500);
  }
});

test("footer: responsible-consumption modal, Instagram + WhatsApp only", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer").first();
  const dialog = page.getByRole("dialog");
  // the page is server-rendered: retry the click until React has hydrated and attached the handler
  await expect(async () => {
    await footer.getByRole("button", { name: "Responsible consumption" }).click();
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(dialog).toContainText("Responsible consumption");
  await expect(dialog).toContainText("SAHPRA");
  await dialog.getByRole("button", { name: "I understand" }).click();
  await expect(dialog).toBeHidden();

  const socials = footer.locator(".socials a");
  await expect(socials).toHaveCount(2);
  await expect(footer.getByRole("link", { name: "Instagram" })).toHaveAttribute(
    "href",
    "https://instagram.com/cannaplug_012",
  );
  await expect(footer.getByRole("link", { name: "WhatsApp Channel" })).toHaveAttribute(
    "href",
    "https://whatsapp.com/channel/0029Vb8vaazDJ6H8OHue3E3Z",
  );
});

test.describe("18+ gate", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("asks once, is remembered, and never blocks /verify or crawlers", async ({
    page,
    browser,
  }) => {
    await page.goto("/");
    const gate = page.getByRole("dialog", { name: "Are you 18 or older?" });
    await expect(gate).toBeVisible({ timeout: 15_000 });
    await gate.getByRole("button", { name: "No" }).click();
    await expect(gate).toContainText("adults aged 18 and over only");
    await gate.getByRole("button", { name: "Yes, I'm 18 or older" }).click();
    await expect(gate).toBeHidden();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(gate).toBeHidden();

    const fresh = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const v = await fresh.newPage();
    await v.goto("/verify/not-a-real-token");
    await v.waitForLoadState("networkidle");
    await expect(v.getByRole("dialog", { name: "Are you 18 or older?" })).toHaveCount(0);
    await fresh.close();

    const bot = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    });
    const b = await bot.newPage();
    await b.goto("/");
    await b.waitForLoadState("networkidle");
    await expect(b.getByRole("dialog", { name: "Are you 18 or older?" })).toHaveCount(0);
    await bot.close();
  });
});
