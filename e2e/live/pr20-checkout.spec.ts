import { expect, test, type Page } from "@playwright/test";
import {
  MANAGER,
  MEMBER,
  OTHER,
  completeOrder,
  productId,
  signInUi,
  sql,
  uniq,
  userId,
} from "./helpers";

/**
 * PR 20 — LIVE checkout end to end: shop -> /checkout -> real order -> /account (live) -> /admin (EFT confirm).
 * Real Chromium + real auth/PostgREST/Realtime/Postgres. Serial: later tests use earlier state.
 */
test.describe.configure({ mode: "serial" });

const BLUE = "live-blue-gelato";
const SOUR = "live-sour-og";

const orderCount = (email: string) =>
  Number(sql(`select count(*) from public.orders where user_id='${userId(email)}'`));
const latestOrder = (email: string) =>
  sql(
    `select id from public.orders where user_id='${userId(email)}' order by created_at desc limit 1`,
  );
const onHand = (slug: string) =>
  Number(
    sql(
      `select coalesce(sum(b.qty_on_hand),0) from public.inventory_batches b join public.products p on p.id=b.product_id where p.slug='${slug}'`,
    ),
  );
const held = (slug: string) =>
  Number(
    sql(
      `select coalesce(sum(b.qty_held),0) from public.inventory_batches b join public.products p on p.id=b.product_id where p.slug='${slug}'`,
    ),
  );

/** Real cart: seed localStorage exactly as the shop's "Add" button would (productId from the DB). */
async function fillCart(
  page: Page,
  items: { slug: string; name: string; price: number; qty: number }[],
) {
  await page.goto("/");
  await page.evaluate(
    (lines) => localStorage.setItem("cannaplug.cart.v1", JSON.stringify(lines)),
    items.map((i) => ({
      productId: productId(i.slug),
      name: i.name,
      price: i.price,
      unit: "per gram",
      quantity: i.qty,
    })),
  );
}

async function toPaymentStep(page: Page, opts: { newAddress?: boolean } = {}) {
  await page.goto("/checkout");
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel("Phone").fill("+27 82 123 4567");
  if (opts.newAddress) {
    await page.getByText("+ Add a new address").click();
    await page.getByLabel("Street address").fill("12 Long Street");
    await page.getByLabel("Suburb").fill("Gardens");
    await page.getByLabel("City").fill("Cape Town");
    await page.getByLabel("Postal code").fill("8001");
    await page.getByRole("button", { name: "Save address" }).click();
    await expect(page.getByText(/12 Long Street, Gardens, Cape Town/)).toBeVisible();
  }
  await page.getByRole("button", { name: /continue/i }).click(); // -> Delivery
  await page.getByLabel(/Discreet delivery/).check();
  await page.getByRole("button", { name: /continue/i }).click(); // -> Payment
}

test("shop: the Add button puts a real product in the cart and checkout shows it", async ({
  page,
}) => {
  await signInUi(page, MEMBER);
  await expect(page.getByRole("heading", { name: /Mia Member/i })).toBeVisible();
  await page.goto("/shop");
  const card = page
    .locator("div", { has: page.getByRole("heading", { name: "Live Blue Gelato" }) })
    .filter({ has: page.getByRole("button", { name: /Add/ }) })
    .last();
  await card.getByRole("button", { name: /Add/ }).click();
  await page.goto("/checkout");
  await expect(page.getByText("Live Blue Gelato").first()).toBeVisible();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("cannaplug.cart.v1") ?? "[]"),
  );
  expect(stored[0].productId).toBe(productId(BLUE)); // a real DB id, not a prototype constant
});

test("CHECKOUT E2E: place an order from the UI; the order is server-priced, held, and arrives LIVE in /account", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInUi(page, MEMBER);
  await expect(page.getByRole("heading", { name: /Mia Member/i })).toBeVisible();

  // A second tab of the same member sits on Orders and must receive the new order WITHOUT a reload.
  const watcher = await ctx.newPage();
  await watcher.goto("/account");
  await watcher.getByRole("button", { name: "Orders", exact: true }).first().click();
  await watcher.evaluate(() => ((window as unknown as { __w: number }).__w = 1));
  const before = orderCount(MEMBER);
  const heldBefore = held(BLUE);

  // The cart holds a WRONG price on purpose (R1): the server must ignore it.
  await fillCart(page, [{ slug: BLUE, name: "Live Blue Gelato", price: 1, qty: 2 }]);
  await toPaymentStep(page, { newAddress: true });

  // Server quote: 2 x R100 + R120 discreet = R320 (never the browser's R1).
  const place = page.getByRole("button", { name: /place order · R320/i });
  await expect(place).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByText("EFT / Bank transfer")).toBeVisible();
  await place.click();

  await expect(page.getByText("Order placed")).toBeVisible({ timeout: 20_000 });
  const number = (await page
    .locator("b")
    .filter({ hasText: /^CP-\d{4}-\d{4}$/ })
    .first()
    .textContent())!;
  expect(number).toMatch(/^CP-\d{4}-\d{4}$/); // real sequence, not Math.random()
  await expect(page.getByText("63210843975")).toBeVisible(); // bank details for the EFT
  expect(await page.evaluate(() => localStorage.getItem("cannaplug.cart.v1"))).toBe("[]");

  // Database truth
  expect(orderCount(MEMBER)).toBe(before + 1);
  const id = latestOrder(MEMBER);
  expect(sql(`select order_number from public.orders where id='${id}'`)).toBe(number);
  expect(Number(sql(`select total_rand from public.orders where id='${id}'`))).toBe(320);
  expect(
    sql(
      `select status || '|' || delivery_method || '|' || payment_method || '|' || delivery_fee_rand from public.orders where id='${id}'`,
    ),
  ).toBe("awaiting_payment|discreet|eft|120.00");
  expect(
    sql(
      `select delivery_address->>'line1' || '|' || (delivery_address->>'postal_code') from public.orders where id='${id}'`,
    ),
  ).toBe("12 Long Street|8001");
  expect(sql(`select contact_phone from public.orders where id='${id}'`)).toBe("+27 82 123 4567");
  expect(held(BLUE)).toBe(heldBefore + 2); // stock reserved
  expect(
    sql(`select count(*) from public.order_items where order_id='${id}' and unit_price_rand = 100`),
  ).toBe("1"); // R100, not R1

  // The member's OTHER open tab received the order live (Realtime orders INSERT -> refetch), no reload.
  const card = watcher.locator("div.rounded-xl").filter({ hasText: number }).first();
  await expect(card).toBeVisible({ timeout: 25_000 });
  await expect(card.getByText("Awaiting payment").first()).toBeVisible();
  await expect(card.getByText("Delivery R120")).toBeVisible();
  await expect(card.getByText("R320", { exact: true })).toBeVisible();
  expect(await watcher.evaluate(() => (window as unknown as { __w?: number }).__w)).toBe(1);
  await ctx.close();
});

test("another customer cannot see the order in /account", async ({ page }) => {
  await signInUi(page, OTHER);
  await page.getByRole("button", { name: "Orders", exact: true }).first().click();
  await expect(page.getByText("No orders yet.")).toBeVisible();
});

test("ADMIN: staff see the order with address + contact, and confirm the EFT (amount-checked, once)", async ({
  browser,
}) => {
  const id = latestOrder(MEMBER);
  const number = sql(`select order_number from public.orders where id='${id}'`);

  // member keeps /account open to watch the status change live
  const memberCtx = await browser.newContext();
  const member = await memberCtx.newPage();
  await signInUi(member, MEMBER);
  await member.getByRole("button", { name: "Orders", exact: true }).first().click();
  const memberCard = member.locator("div.rounded-xl").filter({ hasText: number }).first();
  await expect(memberCard.getByText("Awaiting payment").first()).toBeVisible();

  const staffCtx = await browser.newContext();
  const staff = await staffCtx.newPage();
  await signInUi(staff, MANAGER);
  await expect(staff.getByRole("heading", { name: /Manny Manager/i })).toBeVisible();
  await staff.goto("/admin");
  await staff.getByRole("button", { name: "Orders", exact: true }).first().click();
  await staff.getByRole("row", { name: new RegExp(number) }).click();

  // delivery details reach staff
  const panel = staff.locator("aside").filter({ hasText: number });
  await expect(panel.getByText("Delivery & contact")).toBeVisible();
  await expect(panel.getByText(/12 Long Street, Gardens, Cape Town, 8001/)).toBeVisible();
  await expect(panel.getByText("+27 82 123 4567")).toBeVisible();
  await expect(panel.getByText(/Discreet delivery · Pay by EFT/i)).toBeVisible();
  await expect(panel.getByText("R320").last()).toBeVisible();
  // the bare "Confirmed" button is not offered for an unpaid order; the EFT form is
  await expect(panel.getByRole("button", { name: "Confirmed", exact: true })).toHaveCount(0);
  await expect(panel.getByText("Confirm EFT received")).toBeVisible();

  // wrong amount: nothing changes
  await panel.getByLabel("Bank reference").fill(uniq("EFTREF"));
  await panel.getByLabel("Amount received").fill("200");
  await panel.getByRole("button", { name: "Confirm payment" }).click();
  await expect(panel.getByText(/does not match the order total/i)).toBeVisible({ timeout: 20_000 });
  expect(sql(`select status from public.orders where id='${id}'`)).toBe("awaiting_payment");

  // correct amount: confirmed, stock consumed, receipt recorded
  const ref = uniq("EFTOK");
  const onHandBefore = onHand(BLUE);
  await panel.getByLabel("Bank reference").fill(ref);
  await panel.getByLabel("Amount received").fill("320");
  await panel.getByRole("button", { name: "Confirm payment" }).click();
  await expect(panel.getByText(/Payment recorded/i)).toBeVisible({ timeout: 20_000 });
  expect(sql(`select status from public.orders where id='${id}'`)).toBe("confirmed");
  expect(onHand(BLUE)).toBe(onHandBefore - 2);
  expect(
    sql(
      `select outcome || '|' || amount from public.payment_events where provider='eft' and provider_event_id='${ref}'`,
    ),
  ).toBe("confirmed|320.00");
  expect(
    sql(
      `select count(*) from public.audit_log where action in ('eft_payment_settled','eft_amount_mismatch') and entity_id in (select id from public.payment_transactions where order_id='${id}')`,
    ),
  ).toBe("2"); // the refused attempt is audited too

  // the member's open /account page updates LIVE (status badge + timeline) with no reload
  await expect(memberCard.getByText("Confirmed", { exact: true }).first()).toBeVisible({
    timeout: 25_000,
  });

  // the same bank reference can never confirm another order
  const other = (() => {
    const o = sql(
      `select (public.create_online_order('${userId(MEMBER)}','[{"product_id":"${productId(SOUR)}","quantity":1}]'::jsonb,'x','0820000000',null,'${uniq("o")}',30)->>'order_id');`,
    );
    return o.split("\n").pop()!;
  })();
  expect(
    sql(
      `select (public.confirm_order_payment('eft','${ref}','${other}'::uuid, 150)->>'duplicate')`,
    ),
  ).toBe("true");
  expect(sql(`select status from public.orders where id='${other}'`)).toBe("awaiting_payment");

  // staff continue fulfilment from the same panel
  await panel.getByRole("button", { name: "Packing" }).click();
  await expect(
    member
      .locator("div.rounded-xl")
      .filter({ hasText: number })
      .first()
      .locator("ol")
      .getByText("Being packed"),
  ).toBeVisible({ timeout: 25_000 });
  await memberCtx.close();
  await staffCtx.close();
});

test("price moves while the member reviews: server refuses, cart kept, honest message, then succeeds at the new price", async ({
  page,
}) => {
  await signInUi(page, MEMBER);
  await fillCart(page, [{ slug: SOUR, name: "Live Sour OG", price: 150, qty: 1 }]);
  await toPaymentStep(page);
  await expect(page.getByRole("button", { name: /place order · R270/i })).toBeEnabled({
    timeout: 20_000,
  }); // 150 + 120
  const before = orderCount(MEMBER);

  sql(`update public.products set price_rand = 175 where slug='${SOUR}'`);
  try {
    await page.getByRole("button", { name: /place order · R270/i }).click();
    await expect(page.getByRole("alert")).toContainText(/Prices changed/i, { timeout: 20_000 }); // specific message, not generic
    await expect(page.getByRole("button", { name: /place order · R295/i })).toBeEnabled({
      timeout: 20_000,
    }); // fresh total
    expect(orderCount(MEMBER)).toBe(before); // nothing created
    expect(
      JSON.parse((await page.evaluate(() => localStorage.getItem("cannaplug.cart.v1")))!),
    ).toHaveLength(1); // cart kept

    await page.getByRole("button", { name: /place order · R295/i }).click();
    await expect(page.getByText("Order placed")).toBeVisible({ timeout: 20_000 });
    expect(
      Number(sql(`select total_rand from public.orders where id='${latestOrder(MEMBER)}'`)),
    ).toBe(295);
  } finally {
    sql(`update public.products set price_rand = 150 where slug='${SOUR}'`);
  }
});

test("stock shortfall: checkout blocks ordering and creates nothing", async ({ page }) => {
  await signInUi(page, MEMBER);
  await fillCart(page, [{ slug: SOUR, name: "Live Sour OG", price: 150, qty: 500 }]); // more than exists
  const before = orderCount(MEMBER);
  await toPaymentStep(page);
  await expect(page.getByText(/no longer available in the quantity/i)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: /place order/i })).toBeDisabled();
  expect(orderCount(MEMBER)).toBe(before);
});

test("double-click on Place order creates exactly one order and holds stock once", async ({
  page,
}) => {
  await signInUi(page, MEMBER);
  await fillCart(page, [{ slug: BLUE, name: "Live Blue Gelato", price: 100, qty: 1 }]);
  await toPaymentStep(page);
  const btn = page.getByRole("button", { name: /place order · R220/i });
  await expect(btn).toBeEnabled({ timeout: 20_000 });
  const before = orderCount(MEMBER);
  const heldBefore = held(BLUE);
  // Two clicks in the SAME synchronous tick (a fast double-tap): React has not yet disabled the button,
  // so two placeOrder calls fire with the same idempotency key.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      /place order/i.test(x.textContent ?? ""),
    )!;
    b.click();
    b.click();
  });
  await expect(page.getByText("Order placed")).toBeVisible({ timeout: 20_000 });
  expect(orderCount(MEMBER)).toBe(before + 1);
  expect(held(BLUE)).toBe(heldBefore + 1);
});

test("a completed checkout order can be reordered: delivery + address carry over, fee re-priced", async ({
  page,
}) => {
  await signInUi(page, MEMBER);
  await fillCart(page, [{ slug: BLUE, name: "Live Blue Gelato", price: 100, qty: 2 }]);
  await toPaymentStep(page);
  await page.getByRole("button", { name: /place order/i }).click();
  await expect(page.getByText("Order placed")).toBeVisible({ timeout: 20_000 });
  const id = latestOrder(MEMBER);
  sql(`select public.confirm_order_payment('eft','${uniq("EFTRO")}','${id}'::uuid, 320)`);
  for (const s of ["packing", "ready", "out_for_delivery", "completed"])
    sql(
      `select public.transition_order_status('${id}'::uuid,'${s}','${userId(MANAGER)}'::uuid,null)`,
    );

  sql(`update public.delivery_options set fee_rand = 95 where code='discreet'`);
  try {
    await page.goto("/account");
    await page.getByRole("button", { name: "Orders", exact: true }).first().click();
    const number = sql(`select order_number from public.orders where id='${id}'`);
    await page
      .locator("div.rounded-xl")
      .filter({ hasText: number })
      .first()
      .getByRole("button", { name: "Reorder" })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Includes delivery R95")).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByText("Total R295")).toBeVisible();
    await dialog.getByRole("button", { name: /Place order/ }).click();
    await expect(page.getByRole("status")).toContainText(/placed/i, { timeout: 20_000 });
    const re = latestOrder(MEMBER);
    const carried = sql(
      `select delivery_method || '|' || delivery_fee_rand || '|' || total_rand from public.orders where id='${re}'`,
    );
    expect(carried).toBe("discreet|95.00|295.00");
    // the address snapshot is carried over verbatim from the SOURCE order (whichever address it used)
    expect(sql(`select delivery_address::text from public.orders where id='${re}'`)).toBe(
      sql(`select delivery_address::text from public.orders where id='${id}'`),
    );
  } finally {
    sql(`update public.delivery_options set fee_rand = 120 where code='discreet'`);
  }
  void completeOrder;
});
