import { expect, test, type Page } from "@playwright/test";
import { CRON_SECRET, MANAGER, PAYER, productId, signInUi, sql, userId } from "./helpers";

/**
 * Milestone 5 — LIVE payments end to end in real Chromium against the real app + real Postgres, with the
 * providers replaced by scripts/live-stack/mock-providers.mjs (same API shapes; signed Yoco webhooks).
 * The point of these tests: the order becomes paid ONLY through a verified provider event or a server-side
 * PayPal capture — never because the browser landed on the return URL.
 */
test.describe.configure({ mode: "serial" });

const MOCK = process.env["MOCK_URL"] ?? "http://127.0.0.1:4599";
const BLUE = "live-blue-gelato";

const latestOrder = () =>
  sql(
    `select id from public.orders where user_id='${userId(PAYER)}' order by created_at desc limit 1`,
  );
const status = (id: string) => sql(`select status from public.orders where id='${id}'`);
const txStatus = (id: string) =>
  sql(
    `select status from public.payment_transactions where order_id='${id}' order by created_at desc limit 1`,
  );
const paymentEvents = (id: string) =>
  Number(sql(`select count(*) from public.payment_events where order_id='${id}'`));
const mock = async (path: string, body?: unknown) =>
  (
    await fetch(`${MOCK}${path}`, body ? { method: "POST", body: JSON.stringify(body) } : {})
  ).json() as Promise<{ log: { status: number }[] }>;

async function fillCart(page: Page, qty = 1) {
  await page.goto("/");
  await page.evaluate(
    (lines) => localStorage.setItem("cannaplug.cart.v1", JSON.stringify(lines)),
    [
      {
        productId: productId(BLUE),
        name: "Live Blue Gelato",
        price: 100,
        unit: "per gram",
        quantity: qty,
      },
    ],
  );
}

let addressAdded = false;
async function toPaymentStep(page: Page) {
  await page.goto("/checkout");
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel("Phone").fill("+27 82 123 4567");
  if (!addressAdded) {
    await page.getByText("+ Add a new address").click();
    await page.getByLabel("Street address").fill("1 Payment Road");
    await page.getByLabel("Suburb").fill("Gardens");
    await page.getByLabel("City").fill("Cape Town");
    await page.getByLabel("Postal code").fill("8001");
    await page.getByRole("button", { name: "Save address" }).click();
    await expect(page.getByText(/1 Payment Road/)).toBeVisible();
    addressAdded = true;
  }
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel(/Discreet delivery/).check();
  await page.getByRole("button", { name: /continue/i }).click();
}

async function placeWith(page: Page, method: RegExp) {
  await fillCart(page);
  await toPaymentStep(page);
  await page.getByLabel(method).check();
  await page.getByRole("button", { name: /place order/i }).click();
}

test.beforeAll(async () => {
  // A current USD rate for PayPal regardless of whether the live market feed is reachable from this machine.
  sql(`select public.fx_record_live_rate('ZAR','USD', 17.00, 60, 'live-spec fixture')`);
  await mock("/_config", {
    yocoAmountOverride: null,
    paypalCaptureValue: null,
    replayWebhook: false,
  });
});

test("the checkout offers EFT, card and PayPal when the providers are configured", async ({
  page,
}) => {
  await signInUi(page, PAYER);
  await fillCart(page);
  await toPaymentStep(page);
  await expect(page.getByLabel(/EFT \/ Bank transfer/)).toBeVisible();
  await expect(page.getByLabel(/Card or Instant EFT/)).toBeVisible();
  await expect(page.getByLabel(/PayPal/)).toBeVisible();
});

test("CARD: the order is paid only when the signed Yoco webhook arrives — and a replayed webhook changes nothing", async ({
  page,
}) => {
  await mock("/_config", { replayWebhook: true });
  await signInUi(page, PAYER);
  await placeWith(page, /Card or Instant EFT/);
  await page.waitForURL(/127\.0\.0\.1:4599\/yoco\/pay\//, { timeout: 30_000 });
  const id = latestOrder();
  expect(status(id)).toBe("awaiting_payment"); // hosted page shown, nothing paid yet
  expect(txStatus(id)).toBe("pending");
  // the amount sent to Yoco is the database total (items + delivery), never anything the browser said
  expect(
    sql(
      `select expected_amount||expected_currency from public.payment_transactions where order_id='${id}'`,
    ),
  ).toBe(`${sql(`select total_rand from public.orders where id='${id}'`)}ZAR`);

  await page.getByRole("button", { name: "Pay" }).click();
  await page.waitForURL(/\/payment\/return/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Payment confirmed" })).toBeVisible({
    timeout: 30_000,
  });
  expect(status(id)).toBe("confirmed");
  expect(paymentEvents(id)).toBe(1);
  expect(txStatus(id)).toBe("succeeded");
  const state = await mock("/_state");
  expect(state.log.filter((l) => l.status === 200).length).toBeGreaterThanOrEqual(2); // original + replay both acknowledged
  // confirmation email was QUEUED (never sent from the request path)
  expect(
    sql(
      `select count(*) from public.notification_events where template='order_confirmed' and data->>'order_id'='${id}' and status='queued'`,
    ),
  ).toBe("1");
  await mock("/_config", { replayWebhook: false });
});

test("returning to the success URL WITHOUT paying marks nothing as paid", async ({ page }) => {
  await signInUi(page, PAYER);
  await placeWith(page, /Card or Instant EFT/);
  await page.waitForURL(/127\.0\.0\.1:4599\/yoco\/pay\//, { timeout: 30_000 });
  const id = latestOrder();
  await page.goto(`/payment/return?order=${id}&provider=yoco&result=success`); // the member (or an attacker) walks straight back
  await expect(page.getByRole("heading", { name: /Confirming your payment/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payment confirmed" })).toHaveCount(0);
  expect(status(id)).toBe("awaiting_payment");
  expect(paymentEvents(id)).toBe(0);
  sql(
    `select public.transition_order_status('${id}'::uuid,'cancelled','${userId(MANAGER)}'::uuid,'live test cleanup')`,
  );
});

test("a validly SIGNED event for the wrong amount is held for review, not paid", async ({
  page,
}) => {
  await mock("/_config", { yocoAmountOverride: 100 }); // R1.00 instead of the real total
  await signInUi(page, PAYER);
  await placeWith(page, /Card or Instant EFT/);
  await page.waitForURL(/127\.0\.0\.1:4599\/yoco\/pay\//, { timeout: 30_000 });
  const id = latestOrder();
  await page.getByRole("button", { name: "Pay" }).click();
  await page.waitForURL(/\/payment\/return/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /Confirming your payment/ })).toBeVisible();
  await expect.poll(() => txStatus(id), { timeout: 20_000 }).toBe("review");
  expect(status(id)).toBe("awaiting_payment");
  expect(
    sql(
      `select count(*) from public.notification_events where template='staff_payment_review' and data->>'transaction_id' = (select id::text from public.payment_transactions where order_id='${id}')`,
    ),
  ).not.toBe("0");
  await mock("/_config", { yocoAmountOverride: null });
  sql(
    `select public.transition_order_status('${id}'::uuid,'cancelled','${userId(MANAGER)}'::uuid,'live test cleanup')`,
  );
});

test("forged and tampered webhooks are refused before any business logic", async ({ request }) => {
  const before = Number(sql(`select count(*) from public.webhook_rejections`));
  const forged = await request.post("/api/public/payments/yoco-webhook", {
    data: {
      id: "evt_forged123",
      type: "payment.succeeded",
      payload: { id: "p_1", amount: 10000, currency: "ZAR", mode: "test" },
    },
    headers: {
      "webhook-id": "msg_x",
      "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      "webhook-signature": "v1,AAAA",
    },
  });
  expect(forged.status()).toBe(401);
  const unsigned = await request.post("/api/public/payments/yoco-webhook", {
    data: { hello: "world" },
  });
  expect(unsigned.status()).toBe(401);
  const paypalUnsigned = await request.post("/api/public/payments/paypal-webhook", {
    data: { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED" },
  });
  expect(paypalUnsigned.status()).toBe(401);
  expect(Number(sql(`select count(*) from public.webhook_rejections`))).toBe(before + 3);
  expect(sql(`select count(*) from public.webhook_events where event_key = 'evt_forged123'`)).toBe(
    "0",
  );
});

test("PAYPAL: charged in USD at the stored rate; paid only after the server-side capture", async ({
  page,
}) => {
  await signInUi(page, PAYER);
  await placeWith(page, /PayPal/);
  await page.waitForURL(/127\.0\.0\.1:4599\/paypal\/approve\//, { timeout: 30_000 });
  const id = latestOrder();
  expect(status(id)).toBe("awaiting_payment");
  const row = sql(
    `select expected_currency||'|'||expected_amount||'|'||fx_rate from public.payment_transactions where order_id='${id}' and provider='paypal'`,
  ).split("|");
  expect(row[0]).toBe("USD");
  const total = Number(sql(`select total_rand from public.orders where id='${id}'`));
  expect(Number(row[1])).toBe(Math.ceil((total / Number(row[2])) * 100) / 100); // rand total at the stored rate, rounded UP

  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL(/\/payment\/return/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Payment confirmed" })).toBeVisible({
    timeout: 40_000,
  });
  expect(status(id)).toBe("confirmed");
  expect(paymentEvents(id)).toBe(1);
});

test("PAYPAL: a capture for the wrong amount is held for review, not paid", async ({ page }) => {
  await mock("/_config", { paypalCaptureValue: "0.50" });
  await signInUi(page, PAYER);
  await placeWith(page, /PayPal/);
  await page.waitForURL(/127\.0\.0\.1:4599\/paypal\/approve\//, { timeout: 30_000 });
  const id = latestOrder();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL(/\/payment\/return/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /Confirming your payment/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => txStatus(id), { timeout: 20_000 }).toBe("review"); // the server-side capture runs after the page loads
  expect(status(id)).toBe("awaiting_payment");
  await mock("/_config", { paypalCaptureValue: null });
  sql(
    `select public.transition_order_status('${id}'::uuid,'cancelled','${userId(MANAGER)}'::uuid,'live test cleanup')`,
  );
});

test("ADMIN: managers see the Payments tab with the attempts, FX rate and refused-webhook count", async ({
  page,
}) => {
  await signInUi(page, MANAGER);
  await expect(page.getByRole("heading", { name: /Manny Manager/i })).toBeVisible();
  await page.goto("/admin");
  await page.getByRole("button", { name: "Payments", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible();
  await expect(page.getByText(/PayPal exchange rate/)).toBeVisible();
  await expect(page.getByRole("cell", { name: "yoco" }).first()).toBeVisible();
  await expect(page.getByText("Refused webhooks (24h)")).toBeVisible();
  // the review-held attempts from the earlier tests are called out for a person
  await expect(page.getByRole("heading", { name: /Needs attention/ })).toBeVisible();
});

test("the notification dispatcher is cron-only, and reports 'not configured' instead of burning attempts without an email key", async ({
  request,
}) => {
  const denied = await request.post("/api/public/notifications/dispatch");
  expect([401, 403]).toContain(denied.status());
  const ok = await request.post("/api/public/notifications/dispatch", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  expect(ok.status()).toBe(200);
  const body = await ok.json();
  expect(body.ok).toBe(true);
  expect(body.skippedNotConfigured).toBe(true);
  expect(sql(`select count(*) from public.notification_events where status='queued'`)).not.toBe(
    "0",
  );
});
