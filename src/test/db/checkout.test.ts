import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  advanceOrder,
  asAnon,
  asUser,
  assertInventoryConsistent,
  assertLoyaltyConsistent,
  attempt,
  connect,
  failedWith,
  key,
  loyaltyOf,
  mkProduct,
  mkUser,
  receive,
  rpc,
  uid,
  val,
  type Sql,
} from "./helpers";

/** Checkout end to end — real PostgreSQL. Fees: standard R80, discreet R120 (seeded). */
describe.skipIf(!DB_URL)("checkout (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;

  beforeAll(async () => {
    sql = connect(30);
    manager = await mkUser(sql, "manager");
  });
  afterAll(async () => {
    await sql.end();
  });
  afterEach(async () => {
    await assertInventoryConsistent(sql);
    await assertLoyaltyConsistent(sql);
  });

  const addr = async (user: string, extra: Record<string, unknown> = {}) =>
    (
      await rpc(
        sql,
        "member_save_address",
        user,
        null,
        { label: "Home", line1: "12 Long Street", city: "Cape Town", ...extra },
        false,
      )
    ).id as string;

  async function basket(price = 100, qty = 2, stock = 10) {
    const product = await mkProduct(sql, price);
    await receive(sql, manager, product, stock);
    return { product, items: [{ product_id: product, quantity: qty }] };
  }

  const place = (
    user: string,
    items: unknown,
    address: string,
    total: number | null,
    over: { method?: string; pay?: string; k?: string; name?: string; phone?: string } = {},
  ) =>
    rpc(
      sql,
      "checkout_place_order",
      user,
      items,
      over.name ?? "Test Member",
      over.phone ?? "+27 82 000 0000",
      over.method ?? "standard",
      address,
      over.pay ?? "eft",
      total,
      "Leave at gate",
      over.k ?? key("co"),
    );

  it("quotes server prices, stock and the delivery fee (browser prices are never an input)", async () => {
    const { items } = await basket(100, 2);
    const q = await rpc(sql, "checkout_quote", items, "standard");
    expect(q).toMatchObject({
      orderable: true,
      subtotal: 200,
      delivery_fee: 80,
      total: 280,
      delivery_method: "standard",
    });
    expect(q.lines[0]).toMatchObject({ status: "ok", unit_price: 100, line_total: 200 });
    expect((await rpc(sql, "checkout_quote", items, "discreet")).total).toBe(320);
  });

  it("flags short stock, retired products and bad input", async () => {
    const short = await basket(100, 5, 3);
    const q = await rpc(sql, "checkout_quote", short.items, "standard");
    expect(q).toMatchObject({ orderable: false, total: null });
    expect(q.lines[0]).toMatchObject({ status: "insufficient_stock", available: 3 });

    const retired = await basket();
    await sql`UPDATE public.products SET is_active = false WHERE id = ${retired.product}`;
    expect((await rpc(sql, "checkout_quote", retired.items, "standard")).lines[0].status).toBe(
      "unavailable",
    );

    expect(
      failedWith(await attempt(rpc(sql, "checkout_quote", [], "standard")), "invalid_items"),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(rpc(sql, "checkout_quote", [{ product_id: "x", quantity: 1 }], "standard")),
        "invalid_items",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(rpc(sql, "checkout_quote", short.items, "teleport")),
        "invalid_delivery_method",
      ),
    ).toBe(true);
    await sql`UPDATE public.delivery_options SET is_active = false WHERE code = 'discreet'`;
    expect(
      failedWith(
        await attempt(rpc(sql, "checkout_quote", short.items, "discreet")),
        "invalid_delivery_method",
      ),
    ).toBe(true);
    await sql`UPDATE public.delivery_options SET is_active = true WHERE code = 'discreet'`;
  });

  it("places a real order: server total, delivery snapshot, stock held, timeline row", async () => {
    const u = await mkUser(sql, "customer");
    const a = await addr(u, {
      suburb: "Gardens",
      postal_code: "8001",
      delivery_notes: "Gate code 1234",
    });
    const { product, items } = await basket(100, 2);
    const r = await place(u, items, a, 280);
    expect(r).toMatchObject({
      subtotal: 200,
      delivery_fee: 80,
      total: 280,
      status: "awaiting_payment",
      payment_method: "eft",
      hold_minutes: 120,
    });

    const [o] =
      await sql`SELECT user_id, total_rand, delivery_method, delivery_fee_rand, payment_method, delivery_address, contact_name, notes, status FROM public.orders WHERE id = ${r.order_id}`;
    expect(o).toMatchObject({
      user_id: u,
      delivery_method: "standard",
      payment_method: "eft",
      contact_name: "Test Member",
      notes: "Leave at gate",
      status: "awaiting_payment",
    });
    expect(Number(o!["total_rand"])).toBe(280);
    expect(o!["delivery_address"]).toMatchObject({
      line1: "12 Long Street",
      suburb: "Gardens",
      postal_code: "8001",
      delivery_notes: "Gate code 1234",
    });
    expect(
      await val(
        sql`SELECT COALESCE(sum(quantity),0)::int FROM public.stock_reservations WHERE order_id = ${r.order_id} AND status = 'held'`,
      ),
    ).toBe(2);
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.order_status_history WHERE order_id = ${r.order_id}`,
      ),
    ).toBe(1);
    const [res] =
      await sql`SELECT expires_at - now() AS left FROM public.stock_reservations WHERE order_id = ${r.order_id} LIMIT 1`;
    expect(
      Number(
        await val(
          sql`SELECT extract(epoch from expires_at - now())::int FROM public.stock_reservations WHERE order_id = ${r.order_id} LIMIT 1`,
        ),
      ),
    ).toBeGreaterThan(110 * 60);
    expect(res).toBeTruthy();
    expect(product).toBeTruthy();
  });

  it("keeps the delivery snapshot even if the saved address changes or is deleted", async () => {
    const u = await mkUser(sql, "customer");
    const a = await addr(u);
    const { items } = await basket();
    const r = await place(u, items, a, 280);
    await rpc(
      sql,
      "member_save_address",
      u,
      a,
      { label: "Home", line1: "999 Changed Road", city: "Durban" },
      false,
    );
    await rpc(sql, "member_delete_address", u, a);
    const [o] = await sql`SELECT delivery_address FROM public.orders WHERE id = ${r.order_id}`;
    expect(o!["delivery_address"]).toMatchObject({ line1: "12 Long Street", city: "Cape Town" });
  });

  it("refuses when the total the member saw is stale, and creates nothing", async () => {
    const u = await mkUser(sql, "customer");
    const a = await addr(u);
    const { product, items } = await basket(100, 2);
    await sql`UPDATE public.products SET price_rand = 110 WHERE id = ${product}`;
    const before = await val(sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${u}`);
    const r = await attempt(place(u, items, a, 280));
    expect(failedWith(r, "price_changed")).toBe(true);
    expect(!r.ok && r.message).toContain("R300");
    expect(await val(sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${u}`)).toBe(
      before,
    );
    // A client cannot talk the total down either: the live total wins.
    expect(failedWith(await attempt(place(u, items, a, 1)), "price_changed")).toBe(true);
    expect(failedWith(await attempt(place(u, items, a, null)), "expected_total_required")).toBe(
      true,
    );
    // ...and confirming the current total succeeds at the CURRENT price.
    expect((await place(u, items, a, 300)).total).toBe(300);
  });

  it("refuses unavailable stock/products without creating an order", async () => {
    const u = await mkUser(sql, "customer");
    const a = await addr(u);
    const { items } = await basket(100, 5, 3);
    const r = await attempt(place(u, items, a, 580));
    expect(failedWith(r, "checkout_unavailable")).toBe(true);
    expect(await val(sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${u}`)).toBe(0);
  });

  it("enforces address ownership and completeness", async () => {
    const owner = await mkUser(sql, "customer");
    const thief = await mkUser(sql, "customer");
    const a = await addr(owner);
    const { items } = await basket();
    expect(failedWith(await attempt(place(thief, items, a, 280)), "address_not_found")).toBe(true);
    expect(failedWith(await attempt(place(thief, items, uid(), 280)), "address_not_found")).toBe(
      true,
    );
    expect(await val(sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${thief}`)).toBe(
      0,
    );
    const noCity = (
      await rpc(
        sql,
        "member_save_address",
        owner,
        null,
        { label: "Bare", line1: "1 Nowhere Lane" },
        false,
      )
    ).id as string;
    expect(failedWith(await attempt(place(owner, items, noCity, 280)), "address_incomplete")).toBe(
      true,
    );
  });

  it("validates contact details and only offers EFT", async () => {
    const u = await mkUser(sql, "customer");
    const a = await addr(u);
    const { items } = await basket();
    expect(
      failedWith(
        await attempt(place(u, items, a, 280, { pay: "card" })),
        "payment_method_unsupported",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(place(u, items, a, 280, { pay: "snapscan" })),
        "payment_method_unsupported",
      ),
    ).toBe(true);
    expect(
      failedWith(await attempt(place(u, items, a, 280, { phone: "abc" })), "invalid_contact"),
    ).toBe(true);
    expect(
      failedWith(await attempt(place(u, items, a, 280, { name: " " })), "invalid_contact"),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(place(u, items, a, 280, { method: "teleport" })),
        "invalid_delivery_method",
      ),
    ).toBe(true);
  });

  it("is idempotent: a double-click / retry creates one order and holds stock once", async () => {
    const u = await mkUser(sql, "customer");
    const a = await addr(u);
    const { items } = await basket(100, 2, 10);
    const k = key("co");
    const first = await place(u, items, a, 280, { k });
    const replays = await Promise.all(
      Array.from({ length: 8 }, () => place(u, items, a, 280, { k })),
    );
    for (const r of replays) expect(r.order_id).toBe(first.order_id);
    expect(await val(sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${u}`)).toBe(1);
    expect(
      await val(
        sql`SELECT COALESCE(sum(quantity),0)::int FROM public.stock_reservations WHERE order_id = ${first.order_id} AND status = 'held'`,
      ),
    ).toBe(2);
    expect(
      failedWith(
        await attempt(place(u, items, a, 280, { k, method: "discreet" })),
        "idempotency_conflict",
      ),
    ).toBe(true);
  });

  it("never oversells when two members check out the last units at once", async () => {
    const [c, d] = [await mkUser(sql, "customer"), await mkUser(sql, "customer")];
    const [ac, ad] = [await addr(c), await addr(d)];
    const { items } = await basket(100, 2, 2);
    const res = await Promise.all([
      attempt(place(c, items, ac, 280)),
      attempt(place(d, items, ad, 280)),
    ]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
  });

  it("is not callable by browser roles", async () => {
    const u = await mkUser(sql, "customer");
    const a = await addr(u);
    const { items } = await basket();
    const calls = [
      (tx: Sql) =>
        tx`SELECT public.checkout_place_order(${u}, ${sql.json(items)}, 'N N', '0820000000', 'standard', ${a}, 'eft', 280, null, 'abcdefgh1')`,
      (tx: Sql) => tx`SELECT public.checkout_quote(${sql.json(items)}, 'standard')`,
    ];
    for (const c of calls) expect((await attempt(asUser(sql, u, c))).ok).toBe(false);
    for (const c of calls) expect((await attempt(asAnon(sql, c))).ok).toBe(false);
  });

  it("exposes only active delivery options, read-only, to browsers", async () => {
    expect(
      (await asAnon(sql, (tx) => tx`SELECT code FROM public.delivery_options ORDER BY code`)).map(
        (r) => r["code"],
      ),
    ).toEqual(["discreet", "standard"]);
    const u = await mkUser(sql, "customer");
    expect(
      (await attempt(asUser(sql, u, (tx) => tx`UPDATE public.delivery_options SET fee_rand = 0`)))
        .ok,
    ).toBe(false);
    expect(
      (
        await attempt(
          asUser(
            sql,
            u,
            (tx) =>
              tx`INSERT INTO public.delivery_options (code,label,fee_rand) VALUES ('free','Free',0)`,
          ),
        )
      ).ok,
    ).toBe(false);
  });

  // ---- reaches /admin and /account -----------------------------------------------------------
  it("the order is visible to its owner (account) and to staff tooling (admin), not to other members", async () => {
    const u = await mkUser(sql, "customer");
    const other = await mkUser(sql, "customer");
    const a = await addr(u);
    const { items } = await basket();
    const r = await place(u, items, a, 280);
    expect(
      await asUser(
        sql,
        u,
        (tx) =>
          tx`SELECT order_number, delivery_method, total_rand FROM public.orders WHERE id = ${r.order_id}`,
      ),
    ).toHaveLength(1);
    expect(
      await asUser(sql, other, (tx) => tx`SELECT id FROM public.orders WHERE id = ${r.order_id}`),
    ).toHaveLength(0);
    expect(
      (
        await asUser(
          sql,
          u,
          (tx) =>
            tx`SELECT to_status FROM public.order_status_history WHERE order_id = ${r.order_id}`,
        )
      ).map((x) => x["to_status"]),
    ).toEqual(["awaiting_payment"]);
    // The admin query (service role, no user filter) lists it with the delivery details.
    const [adminRow] =
      await sql`SELECT order_number, delivery_address->>'line1' AS line1, payment_method, status FROM public.orders WHERE id = ${r.order_id}`;
    expect(adminRow).toMatchObject({
      line1: "12 Long Street",
      payment_method: "eft",
      status: "awaiting_payment",
    });
  });

  it("EFT payment confirmation: amount-checked, idempotent per bank reference, consumes stock", async () => {
    const u = await mkUser(sql, "customer");
    const a = await addr(u);
    const { product, items } = await basket(100, 2, 10);
    const r = await place(u, items, a, 280);
    const ref = key("EFT-REF");
    expect(await rpc(sql, "confirm_order_payment", "eft", ref, r.order_id, 200)).toMatchObject({
      outcome: "amount_mismatch",
    });
    expect(
      await rpc(sql, "confirm_order_payment", "eft", ref + "x", r.order_id, 280),
    ).toMatchObject({ outcome: "confirmed" });
    expect(
      await rpc(sql, "confirm_order_payment", "eft", ref + "x", r.order_id, 280),
    ).toMatchObject({ duplicate: true });
    expect(
      (await sql`SELECT status FROM public.orders WHERE id = ${r.order_id}`)[0]!["status"],
    ).toBe("confirmed");
    expect(
      await val(
        sql`SELECT on_hand FROM public.inventory_availability WHERE product_id = ${product}`,
      ),
    ).toBe(8);
  });

  it("a delayed EFT after the hold expired still confirms while stock exists, and fails safely when it does not", async () => {
    const u = await mkUser(sql, "customer");
    const a = await addr(u);
    const { items, product } = await basket(100, 2, 2);
    const r = await place(u, items, a, 280);
    // Same technique as pos-concurrency.test.ts: the guard only allows status transitions, so lapse the hold directly.
    await sql`ALTER TABLE public.stock_reservations DISABLE TRIGGER stock_reservations_guard`;
    await sql`UPDATE public.stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = ${r.order_id}`;
    await sql`ALTER TABLE public.stock_reservations ENABLE TRIGGER stock_reservations_guard`;
    await rpc(sql, "release_expired_reservations");
    // stock is free again; someone else takes all of it
    const d = await mkUser(sql, "customer");
    await place(d, items, await addr(d), 280);
    const late = await rpc(sql, "confirm_order_payment", "eft", key("EFT-LATE"), r.order_id, 280);
    expect(late.outcome).toBe("stock_unavailable_needs_refund");
    expect(
      (await sql`SELECT status FROM public.orders WHERE id = ${r.order_id}`)[0]!["status"],
    ).toBe("awaiting_payment");
    expect(product).toBeTruthy();
  });

  // ---- loyalty + reorder interplay ------------------------------------------------------------
  it("loyalty: redeem applies to goods only, delivery stays payable, and points are earned on goods only", async () => {
    const u = await mkUser(sql, "customer");
    const a = await addr(u);
    // give 500 points: earn via a real completed order of R5000 with the same checkout path
    const big = await basket(5000, 1, 3);
    const first = await place(u, big.items, a, 5080);
    await advanceOrder(sql, manager, first.order_id, "completed");
    expect((await loyaltyOf(sql, u))?.points_balance).toBe(500); // R5000 goods, delivery R80 excluded

    const { items } = await basket(400, 1, 3);
    const o = await place(u, items, a, 480);
    const red = await rpc(sql, "redeem_loyalty_points", u, o.order_id, 200, key("r"));
    expect(red).toMatchObject({ discount: 20, total: 460, balance: 300 }); // 400 + 80 - 20
    expect(
      Number(
        (await sql`SELECT total_rand FROM public.orders WHERE id = ${o.order_id}`)[0]![
          "total_rand"
        ],
      ),
    ).toBe(460);
    // payment compares against the discounted payable total
    expect(
      await rpc(sql, "confirm_order_payment", "eft", key("EFT"), o.order_id, 480),
    ).toMatchObject({ outcome: "amount_mismatch" });
    expect(
      await rpc(sql, "confirm_order_payment", "eft", key("EFT"), o.order_id, 460),
    ).toMatchObject({ outcome: "confirmed" });
    await advanceOrder(sql, manager, o.order_id, "completed").catch(() => {});
  });

  it("reorder copies delivery + address, re-prices the fee, and validates the new total", async () => {
    const u = await mkUser(sql, "customer");
    const a = await addr(u);
    const { product, items } = await basket(100, 2, 10);
    const first = await place(u, items, a, 280);
    await advanceOrder(sql, manager, first.order_id, "completed");
    await sql`UPDATE public.delivery_options SET fee_rand = 95 WHERE code = 'standard'`;
    try {
      const check = await rpc(sql, "reorder_check", u, first.order_id);
      expect(check).toMatchObject({ delivery_fee: 95, current_total: 295, orderable: true });
      const stale = await attempt(rpc(sql, "create_reorder", u, first.order_id, 280, key("ro")));
      expect(failedWith(stale, "price_changed")).toBe(true);
      const ro = await rpc(sql, "create_reorder", u, first.order_id, 295, key("ro"));
      expect(ro.total).toBe(295);
      const [o] =
        await sql`SELECT delivery_method, delivery_fee_rand, delivery_address, payment_method, total_rand FROM public.orders WHERE id = ${ro.order_id}`;
      expect(o).toMatchObject({ delivery_method: "standard", payment_method: "eft" });
      expect(Number(o!["delivery_fee_rand"])).toBe(95);
      expect(o!["delivery_address"]).toMatchObject({ line1: "12 Long Street" });
      expect(product).toBeTruthy();
    } finally {
      await sql`UPDATE public.delivery_options SET fee_rand = 80 WHERE code = 'standard'`;
    }
  });

  it("reorder is blocked when the order's delivery option was retired", async () => {
    const u = await mkUser(sql, "customer");
    const a = await addr(u);
    const { items } = await basket();
    const first = await place(u, items, a, 320, { method: "discreet" });
    await sql`UPDATE public.delivery_options SET is_active = false WHERE code = 'discreet'`;
    try {
      expect(
        failedWith(
          await attempt(rpc(sql, "reorder_check", u, first.order_id)),
          "delivery_unavailable",
        ),
      ).toBe(true);
    } finally {
      await sql`UPDATE public.delivery_options SET is_active = true WHERE code = 'discreet'`;
    }
  });
});
