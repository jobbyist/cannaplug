import { expect, test, type Page } from "@playwright/test";
import {
  MEMBER,
  OTHER,
  accessToken,
  completeOrder,
  createOrder,
  productId,
  realtimeClient,
  rest,
  signInUi,
  sleep,
  sql,
  transition,
  uniq,
  userId,
} from "./helpers";

/**
 * PR 19 (Milestone 4) — LIVE: real Chromium + real auth/PostgREST/Realtime/Postgres.
 * Serial: later tests build on earlier state.
 */
test.describe.configure({ mode: "serial" });

async function openTab(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).first().click();
}

test("member signs in and sees the live account (no prototype data)", async ({ page }) => {
  await signInUi(page, MEMBER);
  await expect(page.getByRole("heading", { name: /Mia Member/i })).toBeVisible();
  // Real, empty state — not the prototype's fabricated orders/points.
  await expect(page.getByText("No orders yet.")).toBeVisible();
  await expect(
    page.getByText("Rewards points").locator("..").getByText("0", { exact: true }),
  ).toBeVisible();
});

test("addresses: add, default, edit, delete — persisted server-side", async ({ page }) => {
  await signInUi(page, MEMBER);
  await openTab(page, "Delivery Addresses");
  await page.getByRole("button", { name: "Add address" }).click();
  await page.getByLabel("Label (e.g. Home, Work)").fill("Home");
  await page.getByLabel("Street address").fill("12 Long Street");
  await page.getByLabel("Suburb").fill("Gardens");
  await page.getByLabel("City").fill("Cape Town");
  await page.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByText("12 Long Street, Gardens, Cape Town")).toBeVisible();
  await expect(page.getByText("Default", { exact: true })).toBeVisible(); // first address becomes default

  await page.getByRole("button", { name: "Add address" }).click();
  await page.getByLabel("Label (e.g. Home, Work)").fill("Work");
  await page.getByLabel("Street address").fill("99 Loop Street");
  await page.getByLabel("City").fill("Cape Town");
  await page.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByText("99 Loop Street, Cape Town")).toBeVisible();
  await page.getByRole("button", { name: "Make default" }).click();
  await expect
    .poll(() =>
      sql(`select count(*) from public.addresses where user_id='${userId(MEMBER)}' and is_default`),
    )
    .toBe("1");
  await expect
    .poll(() =>
      sql(`select label from public.addresses where user_id='${userId(MEMBER)}' and is_default`),
    )
    .toBe("Work");

  await page.reload();
  await openTab(page, "Delivery Addresses");
  await expect(page.getByText("99 Loop Street, Cape Town")).toBeVisible(); // survives a reload

  // delete the non-default one
  const home = page.locator("div.rounded-xl", { hasText: "12 Long Street" }).first();
  await home.getByRole("button", { name: "Delete address" }).click();
  await expect(page.getByText("12 Long Street")).toHaveCount(0);
  expect(sql(`select count(*) from public.addresses where user_id='${userId(MEMBER)}'`)).toBe("1");
});

test("wishlist + back-in-stock under RLS, persisted across reloads", async ({ page }) => {
  await signInUi(page, MEMBER);
  await openTab(page, "Saved Products");
  const card = page.locator("div.rounded-xl", { hasText: "Live Blue Gelato" }).first();
  await card.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("button", { name: "Remove from saved" }).first()).toBeVisible();
  expect(
    sql(
      `select count(*) from public.wishlist_items where user_id='${userId(MEMBER)}' and product_id='${productId("live-blue-gelato")}'`,
    ),
  ).toBe("1");

  // sold-out product offers the stock alert; in-stock products do not
  const soldOut = page.locator("div.rounded-xl", { hasText: "Live Sold-Out Edible" }).first();
  await expect(soldOut.getByText("Out of stock")).toBeVisible();
  await soldOut.getByRole("button", { name: "Notify me when back in stock" }).click();
  await expect(soldOut.getByRole("button", { name: "Stop back-in-stock alert" })).toBeVisible();
  expect(
    sql(`select status from public.back_in_stock_subscriptions where user_id='${userId(MEMBER)}'`),
  ).toBe("active");
  await expect(card.getByRole("button", { name: /back in stock/i })).toHaveCount(0);

  await page.reload();
  await openTab(page, "Saved Products");
  await expect(page.getByRole("button", { name: "Remove from saved" }).first()).toBeVisible();
});

test("order timeline updates LIVE over Realtime — no reload", async ({ page }) => {
  const orderId = createOrder(MEMBER, "live-blue-gelato", 2);
  await signInUi(page, MEMBER);
  await openTab(page, "Orders");
  const order = page.locator("div.rounded-xl", { has: page.getByText("Awaiting payment") }).first();
  await expect(order).toBeVisible();
  await expect(order.getByText("Awaiting payment").first()).toBeVisible();

  // Prove nothing reloads the page: this marker would vanish on navigation.
  await page.evaluate(() => ((window as unknown as { __live: number }).__live = 1));
  transition(orderId, "confirmed", "internal: ID checked, do not show");
  const timeline = order.locator("ol");
  await expect(timeline.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(order.getByText("Confirmed", { exact: true })).toHaveCount(2); // badge + timeline step
  transition(orderId, "packing");
  await expect(timeline.getByText("Being packed")).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as { __live?: number }).__live)).toBe(1);
  // The staff-only note never reaches the browser.
  await expect(page.getByText("internal: ID checked")).toHaveCount(0);
  transition(orderId, "ready");
});

test("REALTIME ISOLATION: another customer never receives this member's order data", async () => {
  const memberToken = await accessToken(MEMBER);
  const otherToken = await accessToken(OTHER);
  const tables = ["orders", "order_status_history", "loyalty_accounts", "loyalty_transactions"];
  const mine = await realtimeClient(memberToken, tables);
  const theirs = await realtimeClient(otherToken, tables);
  try {
    const orderId = createOrder(MEMBER, "live-sour-og", 1); // INSERT orders + history row
    transition(orderId, "confirmed", "SECRET staff note");
    completeOrderRest(orderId);
    await sleep(6000);

    // Control: the member's own client DOES receive their changes (so the silence below means something).
    expect(mine.events.length).toBeGreaterThan(0);
    expect(mine.events.some((e) => e.table === "order_status_history")).toBe(true);
    expect(mine.events.some((e) => e.table === "orders")).toBe(true);
    expect(mine.events.some((e) => e.table === "loyalty_transactions")).toBe(true);
    // Column privileges are enforced on the stream: no staff note, no actor id.
    for (const e of mine.events.filter((x) => x.table === "order_status_history")) {
      expect(e.record).toBeTruthy();
      expect(Object.keys(e.record!)).not.toContain("note");
      expect(Object.keys(e.record!)).not.toContain("actor_user_id");
    }
    expect(JSON.stringify(mine.events)).not.toContain("SECRET staff note");

    // The other customer received NOTHING about the member's order, history, items or points.
    expect(theirs.events, `leaked: ${JSON.stringify(theirs.events)}`).toEqual([]);
  } finally {
    mine.close();
    theirs.close();
  }
});

function completeOrderRest(orderId: string) {
  for (const s of ["packing", "ready", "out_for_delivery", "completed"]) transition(orderId, s);
}

test("direct API tampering by a signed-in member is refused by the real database", async () => {
  const token = await accessToken(MEMBER);
  const other = await accessToken(OTHER);
  const me = userId(MEMBER);

  // loyalty: no direct write of a balance, ledger row, tier or rule
  const forged = await rest(token, `loyalty_accounts?user_id=eq.${me}`, {
    method: "PATCH",
    body: JSON.stringify({ points_balance: 999999 }),
  });
  expect([401, 403]).toContain(forged.status);
  expect([401, 403]).toContain(
    (
      await rest(token, "loyalty_accounts", {
        method: "POST",
        body: JSON.stringify({ user_id: me, points_balance: 5 }),
      })
    ).status,
  );
  expect([401, 403]).toContain(
    (
      await rest(token, "loyalty_transactions", {
        method: "POST",
        body: JSON.stringify({
          user_id: me,
          txn_type: "earn",
          source_type: "order",
          source_id: me,
          points: 100,
          balance_after: 100,
        }),
      })
    ).status,
  );
  expect([401, 403]).toContain(
    (await rest(token, "loyalty_rules", { method: "PATCH", body: JSON.stringify({ value: 0.01 }) }))
      .status,
  );
  expect(
    sql(
      `select coalesce(sum(points_balance),0) from public.loyalty_accounts where user_id='${me}'`,
    ),
  ).not.toBe("999999");

  // orders / addresses: cannot write directly, cannot read others'
  expect([401, 403]).toContain(
    (
      await rest(token, "orders", {
        method: "POST",
        body: JSON.stringify({ user_id: me, total_rand: 1 }),
      })
    ).status,
  );
  expect([401, 403]).toContain(
    (
      await rest(token, `orders?user_id=eq.${me}`, {
        method: "PATCH",
        body: JSON.stringify({ total_rand: 0 }),
      })
    ).status,
  );
  expect([401, 403]).toContain(
    (
      await rest(token, "addresses", {
        method: "POST",
        body: JSON.stringify({ user_id: me, line1: "direct insert" }),
      })
    ).status,
  );
  const otherOrders = (await rest(other, "orders?select=id")).body as unknown[];
  const memberOrdersSeenByOther = (await rest(other, `orders?select=id&user_id=eq.${me}`))
    .body as unknown[];
  expect(memberOrdersSeenByOther).toEqual([]);
  expect(Array.isArray(otherOrders)).toBe(true);
  const hist = await rest(token, "order_status_history?select=note");
  expect([401, 403]).toContain(hist.status); // note column is not selectable
  expect(
    ((await rest(token, "order_status_history?select=to_status")).body as unknown[]).length,
  ).toBeGreaterThan(0);

  // privileged RPCs are not callable from the browser
  expect([401, 403, 404]).toContain(
    (
      await rest(token, "rpc/redeem_loyalty_points", {
        method: "POST",
        body: JSON.stringify({
          p_user_id: me,
          p_order_id: me,
          p_points: 100,
          p_idempotency_key: "abcdefgh12",
        }),
      })
    ).status,
  );
  expect([401, 403, 404]).toContain(
    (await rest(token, "rpc/create_reorder", { method: "POST", body: JSON.stringify({}) })).status,
  );
});

test("loyalty: points earned on completed orders show in Rewards; redemption applies a limited discount", async ({
  page,
}) => {
  // earn: a R1000 order completed by staff => 100 points (rule: 1 point per R10)
  const earnOrder = createOrder(MEMBER, "live-blue-gelato", 10);
  completeOrder(earnOrder);
  const balance = Number(
    sql(`select points_balance from public.loyalty_accounts where user_id='${userId(MEMBER)}'`),
  );
  expect(balance).toBeGreaterThanOrEqual(100);

  const unpaid = createOrder(MEMBER, "live-sour-og", 4); // R600 subtotal
  await signInUi(page, MEMBER);
  await openTab(page, "Rewards & Loyalty");
  await expect(page.getByText(String(balance), { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Earned on an online order").first()).toBeVisible();

  await openTab(page, "Orders");
  // Anchor on the order number: the "Use points" box disappears once points are applied.
  const number = sql(`select order_number from public.orders where id='${unpaid}'`);
  const card = page.locator("div.rounded-xl").filter({ hasText: number }).first();
  await expect(card.getByText("Use points on this order")).toBeVisible();
  const input = card.getByLabel("Points to redeem");
  await input.fill("100");
  await card.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(card.getByText(/100 points applied/)).toBeVisible();
  // database truth: discount R10, payable R590, balance reduced, one ledger row linked to the order
  expect(Number(sql(`select total_rand from public.orders where id='${unpaid}'`))).toBe(590);
  expect(sql(`select loyalty_points_redeemed from public.orders where id='${unpaid}'`)).toBe("100");
  expect(
    sql(
      `select count(*) from public.loyalty_transactions where source_type='order_redeem' and source_id='${unpaid}'`,
    ),
  ).toBe("1");
  expect(
    Number(
      sql(`select points_balance from public.loyalty_accounts where user_id='${userId(MEMBER)}'`),
    ),
  ).toBe(balance - 100);
  // cannot apply a second time (UI hides the box) — and the server refuses a replay too
  await expect(card.getByLabel("Points to redeem")).toHaveCount(0);
  expect(() =>
    sql(
      `select public.redeem_loyalty_points('${userId(MEMBER)}','${unpaid}',100,'${uniq("again")}');`,
    ),
  ).toThrow();
  // cancelling returns the points exactly once
  transition(unpaid, "cancelled");
  await expect
    .poll(() =>
      Number(
        sql(`select points_balance from public.loyalty_accounts where user_id='${userId(MEMBER)}'`),
      ),
    )
    .toBe(balance);
});

test("reorder revalidates current price and stock before creating an order", async ({ page }) => {
  const past = createOrder(MEMBER, "live-blue-gelato", 2);
  completeOrder(past);
  await signInUi(page, MEMBER);
  await openTab(page, "Orders");
  const row = page
    .locator("div.rounded-xl", { hasText: /Live|Blue Gelato/ })
    .filter({ has: page.getByRole("button", { name: "Reorder" }) })
    .first();
  await row.getByRole("button", { name: "Reorder" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Checking availability…")).toHaveCount(0, { timeout: 20_000 });
  await expect(dialog.getByRole("button", { name: /Place order/ })).toBeEnabled();

  // Price changes while the member is looking at the dialog => nothing is created, fresh total shown.
  sql(`update public.products set price_rand = 120 where slug='live-blue-gelato'`);
  const before = sql(
    `select count(*) from public.orders where user_id='${userId(MEMBER)}' and notes like 'Reorder of%'`,
  );
  await dialog.getByRole("button", { name: /Place order/ }).click();
  await expect(dialog.getByText(/Prices changed/i)).toBeVisible({ timeout: 20_000 });
  expect(
    sql(
      `select count(*) from public.orders where user_id='${userId(MEMBER)}' and notes like 'Reorder of%'`,
    ),
  ).toBe(before);
  await expect(dialog.getByText(/R120/).first()).toBeVisible();

  // Confirming the refreshed total creates the order at the CURRENT price with stock held.
  await dialog.getByRole("button", { name: /Place order/ }).click();
  await expect(page.getByRole("status")).toContainText(/placed/i, { timeout: 20_000 });
  const newest = sql(
    `select id from public.orders where user_id='${userId(MEMBER)}' and notes like 'Reorder of%' order by created_at desc limit 1`,
  );
  expect(Number(sql(`select total_rand from public.orders where id='${newest}'`))).toBe(240);
  expect(
    Number(
      sql(
        `select coalesce(sum(quantity),0) from public.stock_reservations where order_id='${newest}' and status='held'`,
      ),
    ),
  ).toBe(2);
  sql(`update public.products set price_rand = 100 where slug='live-blue-gelato'`);

  // Retired product => reorder is blocked with an explanation.
  sql(`update public.products set is_active = false where slug='live-blue-gelato'`);
  await page.reload();
  await openTab(page, "Orders");
  await page.getByRole("button", { name: "Reorder" }).first().click();
  await expect(
    page
      .getByRole("dialog")
      .getByText(/no longer available/i)
      .first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("dialog").getByRole("button", { name: /Place order/ }),
  ).toBeDisabled();
  sql(`update public.products set is_active = true where slug='live-blue-gelato'`);
});

test("a second member's account shows only their own data", async ({ page }) => {
  await signInUi(page, OTHER);
  await expect(page.getByRole("heading", { name: /Omar Other/i })).toBeVisible();
  await openTab(page, "Orders");
  await expect(page.getByText("No orders yet.")).toBeVisible();
  await openTab(page, "Delivery Addresses");
  await expect(page.getByText(/Loop Street|Long Street/)).toHaveCount(0);
  await openTab(page, "Saved Products");
  await expect(page.getByRole("button", { name: "Remove from saved" })).toHaveCount(0);
});
