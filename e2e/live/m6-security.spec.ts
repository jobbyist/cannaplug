import { expect, test } from "@playwright/test";
import { MANAGER, MEMBER, signInUi } from "./helpers";

/** M6: the CSP/headers must not break the real app — pages render, hydrate and talk to the API with ZERO CSP violations. */
test("every key page loads under the CSP with no violations and the headers are present", async ({
  page,
  browser,
}) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) violations.push(m.text());
  });
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });

  const res = await page.goto("/");
  const h = res!.headers();
  expect(h["content-security-policy"]).toContain("default-src 'self'");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["permissions-policy"]).toContain("camera=()");

  await signInUi(page, MEMBER);
  for (const path of [
    "/",
    "/shop",
    "/journal",
    "/checkout",
    "/account",
    "/faq",
    "/privacy-policy",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const inPage = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    violations.push(...inPage.map((v) => `${path}: ${v}`));
  }
  expect(violations).toEqual([]);

  // staff pages too (charts, realtime websocket, server functions) — a separate browser context signs in as the manager
  const staff = await (await browser.newContext()).newPage();
  await staff.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
  await signInUi(staff, MANAGER);
  for (const tab of ["Overview", "POS", "Orders", "Payments"]) {
    await staff.goto("/admin");
    await staff.getByRole("button", { name: tab, exact: true }).first().click();
    await staff.waitForLoadState("networkidle");
  }
  violations.push(
    ...(await staff.evaluate(() => (window as unknown as { __csp: string[] }).__csp)),
  );
  expect(violations).toEqual([]);
});

test("the contact form delivers through the queue (stored, team email + acknowledgement queued), honeypot bots store nothing", async ({
  page,
}) => {
  const { sql } = await import("./helpers");
  const EMAIL = `live-tester-${Date.now().toString(36)}@example.com`;
  const before = Number(sql(`select count(*) from public.contact_submissions`));
  await page.goto("/#contact");
  await page.getByPlaceholder("Your name").fill("Live Tester");
  await page.locator('.contact form input[type="email"]').fill(EMAIL);
  await page.getByPlaceholder("How can we help?").fill("Live contact test");
  await page.getByPlaceholder("Write your message…").fill("Hello from the live browser test.");
  await page.getByRole("button", { name: /send message/i }).click();
  await expect(page.getByText(/we have received your message/i)).toBeVisible({ timeout: 20_000 });
  expect(Number(sql(`select count(*) from public.contact_submissions`))).toBe(before + 1);
  expect(
    sql(
      `select count(*) from public.notification_events where template in ('contact_form_staff','contact_form_ack') and data->>'email'='${EMAIL}' and status='queued'`,
    ),
  ).toBe("2");
  expect(
    sql(
      `select recipient from public.notification_events where template='contact_form_staff' and data->>'email'='${EMAIL}'`,
    ),
  ).toBe("info@cannaplug012.co.za");

  // newsletter
  await page.locator('footer input[type="email"]').fill(`sub-${EMAIL}`);
  await page.getByRole("button", { name: /join/i }).click();
  await expect(page.getByText(/check your inbox/i)).toBeVisible({ timeout: 20_000 });
  expect(sql(`select count(*) from public.newsletter_subscribers where email='sub-${EMAIL}'`)).toBe(
    "1",
  );
});
