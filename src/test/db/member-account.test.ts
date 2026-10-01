import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  advanceOrder,
  asAnon,
  asUser,
  assertInventoryConsistent,
  assertLoyaltyConsistent,
  attempt,
  cash,
  connect,
  earnPoints,
  failedWith,
  key,
  loyaltyOf,
  mkProduct,
  mkSession,
  mkUser,
  placeOrder,
  receive,
  rpc,
  sell,
  uid,
  val,
  type Sql,
} from "./helpers";

/**
 * Milestone 4 — live member account, against real PostgreSQL.
 * Browser behaviour is reproduced with `asUser` (role `authenticated` + JWT subject), which is what
 * PostgREST and Supabase Realtime evaluate for RLS and column privileges.
 */
describe.skipIf(!DB_URL)("Milestone 4 member account (real PostgreSQL)", () => {
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
    await assertLoyaltyConsistent(sql);
    await assertInventoryConsistent(sql);
  });

  const address = (line1 = "12 Long Street", extra: Record<string, unknown> = {}) => ({
    label: "Home",
    line1,
    city: "Cape Town",
    ...extra,
  });

  // -------------------------------------------------------------------------------------------
  describe("addresses: server-side ownership", () => {
    it("lets a member create, edit and delete their own address", async () => {
      const u = await mkUser(sql, "customer");
      const a = await rpc(sql, "member_save_address", u, null, address(), false);
      expect(a.is_default).toBe(true); // first address becomes the default
      const b = await rpc(sql, "member_save_address", u, a.id, address("99 Loop Street"), false);
      expect(b.line1).toBe("99 Loop Street");
      expect(b.is_default).toBe(true); // editing never drops the default
      await rpc(sql, "member_delete_address", u, a.id);
      expect(await val(sql`SELECT count(*)::int FROM public.addresses WHERE user_id = ${u}`)).toBe(
        0,
      );
    });

    it("never lets one member edit, delete or default another member's address", async () => {
      const owner = await mkUser(sql, "customer");
      const intruder = await mkUser(sql, "customer");
      const a = await rpc(
        sql,
        "member_save_address",
        owner,
        null,
        address("1 Private Road"),
        false,
      );

      for (const call of [
        () => rpc(sql, "member_save_address", intruder, a.id, address("Hijacked"), true),
        () => rpc(sql, "member_delete_address", intruder, a.id),
        () => rpc(sql, "member_set_default_address", intruder, a.id),
      ]) {
        const r = await attempt(call());
        expect(failedWith(r, "address_not_found")).toBe(true);
      }
      const [row] = await sql`SELECT line1, user_id FROM public.addresses WHERE id = ${a.id}`;
      expect(row).toMatchObject({ line1: "1 Private Road", user_id: owner });
    });

    it("keeps exactly one default under concurrent 'make default' requests", async () => {
      const u = await mkUser(sql, "customer");
      const ids: string[] = [];
      for (let i = 0; i < 5; i++)
        ids.push((await rpc(sql, "member_save_address", u, null, address(`${i} Road`), false)).id);
      await Promise.all(ids.map((id) => rpc(sql, "member_set_default_address", u, id)));
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          rpc(sql, "member_save_address", u, null, address(`New ${i}`), true).catch(() => null),
        ),
      );
      expect(
        await val(
          sql`SELECT count(*)::int FROM public.addresses WHERE user_id = ${u} AND is_default`,
        ),
      ).toBe(1);
    });

    it("promotes another address when the default is deleted, and caps at 10", async () => {
      const u = await mkUser(sql, "customer");
      const first = await rpc(sql, "member_save_address", u, null, address("A Street"), false);
      await rpc(sql, "member_save_address", u, null, address("B Street"), false);
      await rpc(sql, "member_delete_address", u, first.id);
      expect(
        await val(
          sql`SELECT count(*)::int FROM public.addresses WHERE user_id = ${u} AND is_default`,
        ),
      ).toBe(1);
      for (let i = 0; i < 9; i++)
        await rpc(sql, "member_save_address", u, null, address(`${i} X`), false);
      const over = await attempt(rpc(sql, "member_save_address", u, null, address("11th"), false));
      expect(failedWith(over, "address_limit")).toBe(true);
    });

    it("rejects invalid input", async () => {
      const u = await mkUser(sql, "customer");
      const r = await attempt(rpc(sql, "member_save_address", u, null, { line1: "x" }, false));
      expect(failedWith(r, "invalid_address")).toBe(true);
    });

    it("blocks direct client writes and shows each member only their own rows (RLS)", async () => {
      const a = await mkUser(sql, "customer");
      const b = await mkUser(sql, "customer");
      await rpc(sql, "member_save_address", a, null, address("A only"), false);

      const insert = await attempt(
        asUser(
          sql,
          b,
          (tx) => tx`INSERT INTO public.addresses (user_id, line1) VALUES (${b}, 'direct')`,
        ),
      );
      expect(insert.ok).toBe(false);
      const update = await attempt(
        asUser(
          sql,
          a,
          (tx) => tx`UPDATE public.addresses SET line1 = 'tamper' WHERE user_id = ${a}`,
        ),
      );
      expect(update.ok).toBe(false);
      const del = await attempt(
        asUser(sql, a, (tx) => tx`DELETE FROM public.addresses WHERE user_id = ${a}`),
      );
      expect(del.ok).toBe(false);

      const seenByB = await asUser(sql, b, (tx) => tx`SELECT id FROM public.addresses`);
      expect(seenByB).toHaveLength(0);
      const seenByA = await asUser(sql, a, (tx) => tx`SELECT line1 FROM public.addresses`);
      expect(seenByA.map((r) => r["line1"])).toEqual(["A only"]);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("order timeline + realtime visibility", () => {
    it("adds the member-facing tables to the supabase_realtime publication", async () => {
      const rows = await sql`SELECT tablename FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public'`;
      const names = rows.map((r) => r["tablename"] as string);
      for (const t of [
        "orders",
        "order_status_history",
        "loyalty_accounts",
        "loyalty_transactions",
      ])
        expect(names).toContain(t);
    });

    it("shows a member the timeline of their own orders only, as each change lands", async () => {
      const owner = await mkUser(sql, "customer");
      const other = await mkUser(sql, "customer");
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 5);
      const { orderId } = await placeOrder(sql, owner, [{ product_id: product, quantity: 1 }]);

      const timeline = (who: string) =>
        asUser(
          sql,
          who,
          (tx) => tx`SELECT to_status FROM public.order_status_history WHERE order_id = ${orderId}
                     ORDER BY created_at, id`,
        );
      expect((await timeline(owner)).map((r) => r["to_status"])).toEqual(["awaiting_payment"]);
      expect(await timeline(other)).toHaveLength(0);

      // A staff transition is a new row the owner's Realtime subscription would be sent.
      await rpc(
        sql,
        "transition_order_status",
        orderId,
        "confirmed",
        manager,
        "internal: checked ID",
      );
      expect((await timeline(owner)).map((r) => r["to_status"])).toEqual([
        "awaiting_payment",
        "confirmed",
      ]);
      expect(await timeline(other)).toHaveLength(0);
    });

    it("keeps staff notes and actor ids out of customer reach (column privileges)", async () => {
      const owner = await mkUser(sql, "customer");
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 2);
      const { orderId } = await placeOrder(sql, owner, [{ product_id: product, quantity: 1 }]);
      await rpc(sql, "transition_order_status", orderId, "confirmed", manager, "internal: flagged");

      for (const col of ["note", "actor_user_id"]) {
        const r = await attempt(
          asUser(sql, owner, (tx) => tx.unsafe(`SELECT ${col} FROM public.order_status_history`)),
        );
        expect(r.ok, `column ${col} must not be readable`).toBe(false);
      }
      const star = await attempt(
        asUser(sql, owner, (tx) => tx`SELECT * FROM public.order_status_history`),
      );
      expect(star.ok).toBe(false);
      const anon = await attempt(
        asAnon(sql, (tx) => tx`SELECT id FROM public.order_status_history`),
      );
      expect(anon.ok).toBe(false);
    });

    it("lets a member see only their own orders row changes (orders RLS)", async () => {
      const owner = await mkUser(sql, "customer");
      const other = await mkUser(sql, "customer");
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 2);
      const { orderId } = await placeOrder(sql, owner, [{ product_id: product, quantity: 1 }]);
      expect(
        await asUser(sql, owner, (tx) => tx`SELECT id FROM public.orders WHERE id = ${orderId}`),
      ).toHaveLength(1);
      expect(
        await asUser(sql, other, (tx) => tx`SELECT id FROM public.orders WHERE id = ${orderId}`),
      ).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("loyalty accrual", () => {
    it("credits an online order exactly once, however often accrual is retried", async () => {
      const c = await mkUser(sql, "customer");
      const orderId = await earnPoints(sql, manager, c, 40);
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(40);

      for (let i = 0; i < 5; i++) {
        const again = await rpc(sql, "accrue_order_loyalty", orderId);
        expect(again).toMatchObject({ accrued: false, reason: "already_accrued" });
      }
      await Promise.all(
        Array.from({ length: 12 }, () => rpc(sql, "accrue_order_loyalty", orderId)),
      );
      expect(
        await val(
          sql`SELECT count(*)::int FROM public.loyalty_transactions WHERE source_type = 'order' AND source_id = ${orderId}`,
        ),
      ).toBe(1);
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(40);
    });

    it("does not accrue before the order is completed, and links the row to its order", async () => {
      const c = await mkUser(sql, "customer");
      const product = await mkProduct(sql, 500);
      await receive(sql, manager, product, 1);
      const { orderId } = await placeOrder(sql, c, [{ product_id: product, quantity: 1 }]);
      expect(await rpc(sql, "accrue_order_loyalty", orderId)).toMatchObject({
        reason: "not_completed",
      });
      await advanceOrder(sql, manager, orderId, "completed");
      const [t] =
        await sql`SELECT order_id, txn_type, points, balance_after FROM public.loyalty_transactions WHERE user_id = ${c}`;
      expect(t).toMatchObject({
        order_id: orderId,
        txn_type: "earn",
        points: 50,
        balance_after: 50,
      });
    });

    it("is idempotent when a status trigger and a manual retry race", async () => {
      const c = await mkUser(sql, "customer");
      const product = await mkProduct(sql, 300);
      await receive(sql, manager, product, 1);
      const { orderId } = await placeOrder(sql, c, [{ product_id: product, quantity: 1 }]);
      await advanceOrder(sql, manager, orderId, "completed");
      await Promise.all([
        ...Array.from({ length: 8 }, () => rpc(sql, "accrue_order_loyalty", orderId)),
      ]);
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(30);
    });

    it("promotes the tier from lifetime points and does not demote when points are spent", async () => {
      const c = await mkUser(sql, "customer");
      await earnPoints(sql, manager, c, 600);
      expect(await loyaltyOf(sql, c)).toMatchObject({
        points_balance: 600,
        lifetime_points: 600,
        tier: "sprout",
      });
      const product = await mkProduct(sql, 2000);
      await receive(sql, manager, product, 1);
      const { orderId } = await placeOrder(sql, c, [{ product_id: product, quantity: 1 }]);
      await rpc(sql, "redeem_loyalty_points", c, orderId, 600, key("redeem"));
      expect(await loyaltyOf(sql, c)).toMatchObject({
        points_balance: 0,
        lifetime_points: 600,
        tier: "sprout",
      });
    });

    it("accrues POS sales through the same ledger and reverses them on void, idempotently", async () => {
      const cashier = await mkUser(sql, "budtender");
      const c = await mkUser(sql, "customer");
      const product = await mkProduct(sql, 250);
      await receive(sql, manager, product, 3);
      const { sessionId } = await mkSession(sql, manager, cashier);
      const sale = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 2 }],
        [cash(500)],
        {
          customer: c,
        },
      );
      expect(await rpc(sql, "accrue_pos_loyalty", sale.sale_id)).toMatchObject({
        accrued: true,
        points: 50,
      });
      expect(await rpc(sql, "accrue_pos_loyalty", sale.sale_id)).toMatchObject({
        reason: "already_accrued",
      });
      const [t] =
        await sql`SELECT pos_sale_id, source_type, points FROM public.loyalty_transactions WHERE user_id = ${c}`;
      expect(t).toMatchObject({ pos_sale_id: sale.sale_id, source_type: "pos_sale", points: 50 });
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(50);

      await rpc(sql, "pos_void_sale", manager, sale.sale_id, "customer changed mind", key("void"));
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(0);
      expect(await rpc(sql, "accrue_pos_loyalty", sale.sale_id)).toMatchObject({ accrued: false });
    });

    it("carries pre-existing loyalty_ledger rows into the new ledger exactly once (backfill)", async () => {
      const [missing] = await sql`SELECT count(*)::int AS n FROM public.loyalty_ledger l
        WHERE NOT EXISTS (SELECT 1 FROM public.loyalty_transactions t
                          WHERE t.source_type = l.source_type AND t.source_id = l.source_id)`;
      expect(missing!["n"]).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("loyalty is never client-editable", () => {
    it("denies every client write to accounts, transactions, tiers and rules", async () => {
      const c = await mkUser(sql, "customer");
      await earnPoints(sql, manager, c, 20);
      const attempts: [string, () => Promise<unknown>][] = [
        [
          "update balance",
          () =>
            asUser(
              sql,
              c,
              (tx) =>
                tx`UPDATE public.loyalty_accounts SET points_balance = 999999 WHERE user_id = ${c}`,
            ),
        ],
        [
          "insert account",
          () =>
            asUser(
              sql,
              c,
              (tx) =>
                tx`INSERT INTO public.loyalty_accounts (user_id, points_balance) VALUES (${uid()}, 5)`,
            ),
        ],
        [
          "delete account",
          () =>
            asUser(sql, c, (tx) => tx`DELETE FROM public.loyalty_accounts WHERE user_id = ${c}`),
        ],
        [
          "insert txn",
          () =>
            asUser(
              sql,
              c,
              (tx) =>
                tx`INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, order_id, points, balance_after) VALUES (${c}, 'earn', 'order', ${uid()}, ${uid()}, 1000, 1000)`,
            ),
        ],
        [
          "update txn",
          () =>
            asUser(
              sql,
              c,
              (tx) => tx`UPDATE public.loyalty_transactions SET points = 9999 WHERE user_id = ${c}`,
            ),
        ],
        [
          "update rule",
          () => asUser(sql, c, (tx) => tx`UPDATE public.loyalty_rules SET value = 0.01`),
        ],
        [
          "update tier",
          () => asUser(sql, c, (tx) => tx`UPDATE public.loyalty_tiers SET min_lifetime_points = 0`),
        ],
      ];
      for (const [label, run] of attempts) expect((await attempt(run())).ok, label).toBe(false);
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(20);
    });

    it("blocks balance edits for the service role too — only the ledger trigger may write", async () => {
      const c = await mkUser(sql, "customer");
      await earnPoints(sql, manager, c, 20);
      const forged = await attempt(
        sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE service_role`;
          await tx`UPDATE public.loyalty_accounts SET points_balance = 5000 WHERE user_id = ${c}`;
        }),
      );
      expect(!forged.ok && forged.message).toContain("maintained by the loyalty ledger only");
      const edit = await attempt(
        sql`UPDATE public.loyalty_transactions SET points = 5000 WHERE user_id = ${c}`,
      );
      expect(!edit.ok && edit.message).toContain("append-only");
      const del = await attempt(sql`DELETE FROM public.loyalty_transactions WHERE user_id = ${c}`);
      expect(!del.ok && del.message).toContain("append-only");
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(20);
    });

    it("scopes reads to the owner and exposes tiers/rules to signed-in members only", async () => {
      const a = await mkUser(sql, "customer");
      const b = await mkUser(sql, "customer");
      await earnPoints(sql, manager, a, 30);
      expect(await asUser(sql, a, (tx) => tx`SELECT * FROM public.loyalty_accounts`)).toHaveLength(
        1,
      );
      expect(await asUser(sql, b, (tx) => tx`SELECT * FROM public.loyalty_accounts`)).toHaveLength(
        0,
      );
      expect(
        await asUser(sql, b, (tx) => tx`SELECT * FROM public.loyalty_transactions`),
      ).toHaveLength(0);
      expect(
        (await asUser(sql, a, (tx) => tx`SELECT * FROM public.loyalty_transactions`)).length,
      ).toBeGreaterThan(0);
      expect((await asUser(sql, b, (tx) => tx`SELECT * FROM public.loyalty_rules`)).length).toBe(4);
      expect((await attempt(asAnon(sql, (tx) => tx`SELECT * FROM public.loyalty_rules`))).ok).toBe(
        false,
      );
    });

    it("cannot be reached by clients through the RPC surface", async () => {
      const c = await mkUser(sql, "customer");
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 1);
      const { orderId } = await placeOrder(sql, c, [{ product_id: product, quantity: 1 }]);
      for (const call of [
        (tx: Sql) => tx`SELECT public.redeem_loyalty_points(${c}, ${orderId}, 100, 'abcdefgh1')`,
        (tx: Sql) => tx`SELECT public.accrue_order_loyalty(${orderId})`,
        (tx: Sql) => tx`SELECT public.create_reorder(${c}, ${orderId}, 100, 'abcdefgh1')`,
        (tx: Sql) =>
          tx`SELECT public.member_save_address(${c}, NULL, '{"line1":"abc street"}'::jsonb, true)`,
      ]) {
        expect((await attempt(asUser(sql, c, call))).ok).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("loyalty redemption limits", () => {
    async function orderOf(customer: string, price: number, qty = 1) {
      const product = await mkProduct(sql, price);
      await receive(sql, manager, product, qty);
      return placeOrder(sql, customer, [{ product_id: product, quantity: qty }]);
    }

    it("applies a discount and keeps total_rand as the payable amount", async () => {
      const c = await mkUser(sql, "customer");
      await earnPoints(sql, manager, c, 300);
      const { orderId } = await orderOf(c, 400);
      const r = await rpc(sql, "redeem_loyalty_points", c, orderId, 200, key("r"));
      expect(r).toMatchObject({ points: 200, discount: 20, total: 380, balance: 100 });
      const [o] =
        await sql`SELECT total_rand, loyalty_points_redeemed, loyalty_discount_rand FROM public.orders WHERE id = ${orderId}`;
      expect(Number(o!["total_rand"])).toBe(380);
      expect(o).toMatchObject({ loyalty_points_redeemed: 200 });
      // The payment confirmation compares against the discounted amount.
      expect(
        await rpc(sql, "confirm_order_payment", "manual", key("pay"), orderId, 400),
      ).toMatchObject({
        outcome: "amount_mismatch",
      });
      expect(
        await rpc(sql, "confirm_order_payment", "manual", key("pay"), orderId, 380),
      ).toMatchObject({
        outcome: "confirmed",
      });
    });

    it("enforces the minimum, the balance and the per-order share", async () => {
      const c = await mkUser(sql, "customer");
      await earnPoints(sql, manager, c, 700);
      const { orderId } = await orderOf(c, 100); // max 50% = R50 = 500 points

      const low = await attempt(rpc(sql, "redeem_loyalty_points", c, orderId, 99, key("r")));
      expect(failedWith(low, "below_minimum")).toBe(true);
      const high = await attempt(rpc(sql, "redeem_loyalty_points", c, orderId, 501, key("r")));
      expect(failedWith(high, "exceeds_order_limit")).toBe(true);
      const zero = await attempt(rpc(sql, "redeem_loyalty_points", c, orderId, 0, key("r")));
      expect(failedWith(zero, "invalid_points")).toBe(true);
      const neg = await attempt(rpc(sql, "redeem_loyalty_points", c, orderId, -500, key("r")));
      expect(failedWith(neg, "invalid_points")).toBe(true);

      const ok = await rpc(sql, "redeem_loyalty_points", c, orderId, 500, key("r"));
      expect(ok).toMatchObject({ discount: 50, total: 50, balance: 200 });

      // Overspending the balance on a different order is refused by the ledger itself.
      const big = await orderOf(c, 5000);
      const over = await attempt(rpc(sql, "redeem_loyalty_points", c, big.orderId, 300, key("r")));
      expect(failedWith(over, "insufficient_points")).toBe(true);
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(200);
    });

    it("allows only one redemption per order", async () => {
      const c = await mkUser(sql, "customer");
      await earnPoints(sql, manager, c, 500);
      const { orderId } = await orderOf(c, 1000);
      await rpc(sql, "redeem_loyalty_points", c, orderId, 100, key("r"));
      const second = await attempt(rpc(sql, "redeem_loyalty_points", c, orderId, 100, key("r")));
      expect(failedWith(second, "redemption_exists")).toBe(true);
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(400);
    });

    it("is replay-safe: the same idempotency key deducts once", async () => {
      const c = await mkUser(sql, "customer");
      await earnPoints(sql, manager, c, 500);
      const { orderId } = await orderOf(c, 1000);
      const k = key("replay");
      const first = await rpc(sql, "redeem_loyalty_points", c, orderId, 150, k);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => rpc(sql, "redeem_loyalty_points", c, orderId, 150, k)),
      );
      for (const r of results) expect(r).toMatchObject({ points: 150, discount: first.discount });
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(350);
      const reuse = await attempt(rpc(sql, "redeem_loyalty_points", c, orderId, 200, k));
      expect(failedWith(reuse, "idempotency_conflict")).toBe(true);
    });

    it("cannot double-spend one balance across two orders under concurrency", async () => {
      const c = await mkUser(sql, "customer");
      await earnPoints(sql, manager, c, 100);
      const orders = await Promise.all(Array.from({ length: 4 }, () => orderOf(c, 1000)));
      const settled = await Promise.all(
        orders.map((o) => attempt(rpc(sql, "redeem_loyalty_points", c, o.orderId, 100, key("r")))),
      );
      expect(settled.filter((s) => s.ok)).toHaveLength(1);
      for (const s of settled.filter((s) => !s.ok))
        expect(failedWith(s, "insufficient_points")).toBe(true);
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(0);
    });

    it("enforces ownership: a member cannot redeem against someone else's order", async () => {
      const owner = await mkUser(sql, "customer");
      const thief = await mkUser(sql, "customer");
      await earnPoints(sql, manager, thief, 500);
      const { orderId } = await orderOf(owner, 1000);
      const r = await attempt(rpc(sql, "redeem_loyalty_points", thief, orderId, 100, key("r")));
      expect(failedWith(r, "order_not_found")).toBe(true);
      expect((await loyaltyOf(sql, thief))?.points_balance).toBe(500);
      const [o] =
        await sql`SELECT loyalty_points_redeemed FROM public.orders WHERE id = ${orderId}`;
      expect(o!["loyalty_points_redeemed"]).toBe(0);
    });

    it("refuses redemption once the order is paid, and gives points back on cancellation (once)", async () => {
      const c = await mkUser(sql, "customer");
      await earnPoints(sql, manager, c, 500);
      const paid = await orderOf(c, 1000);
      await advanceOrder(sql, manager, paid.orderId, "confirmed");
      const late = await attempt(rpc(sql, "redeem_loyalty_points", c, paid.orderId, 100, key("r")));
      expect(failedWith(late, "order_not_redeemable")).toBe(true);

      const open = await orderOf(c, 1000);
      await rpc(sql, "redeem_loyalty_points", c, open.orderId, 200, key("r"));
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(300);
      await advanceOrder(sql, manager, open.orderId, "cancelled");
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(500);
      expect(
        await val(
          sql`SELECT count(*)::int FROM public.loyalty_transactions WHERE source_type = 'order_redeem_release' AND source_id = ${open.orderId}`,
        ),
      ).toBe(1);
      expect(await rpc(sql, "reverse_order_loyalty", open.orderId)).toMatchObject({
        reversed: true,
      });
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(500); // retry changes nothing
    });

    it("earns on the amount actually paid, after the redemption discount", async () => {
      const c = await mkUser(sql, "customer");
      await earnPoints(sql, manager, c, 500);
      const { orderId } = await orderOf(c, 1000);
      await rpc(sql, "redeem_loyalty_points", c, orderId, 500, key("r")); // R50 off -> R950 payable
      await advanceOrder(sql, manager, orderId, "completed");
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(0 + 95);
    });

    it("lets a reversal take the balance below zero (clawback) but then blocks redemption", async () => {
      const cashier = await mkUser(sql, "budtender");
      const c = await mkUser(sql, "customer");
      const product = await mkProduct(sql, 1000);
      await receive(sql, manager, product, 2);
      const { sessionId } = await mkSession(sql, manager, cashier);
      const sale = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 1 }],
        [cash(1000)],
        { customer: c },
      );
      await rpc(sql, "accrue_pos_loyalty", sale.sale_id); // +100
      const { orderId } = await orderOf(c, 1000);
      await rpc(sql, "redeem_loyalty_points", c, orderId, 100, key("r")); // spend all 100
      await rpc(sql, "pos_void_sale", manager, sale.sale_id, "fraud", key("void")); // -100
      expect((await loyaltyOf(sql, c))?.points_balance).toBe(-100);
      const next = await orderOf(c, 1000);
      const blocked = await attempt(
        rpc(sql, "redeem_loyalty_points", c, next.orderId, 100, key("r")),
      );
      expect(failedWith(blocked, "insufficient_points")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("wishlist and back-in-stock (RLS)", () => {
    it("lets a member manage only their own wishlist", async () => {
      const a = await mkUser(sql, "customer");
      const b = await mkUser(sql, "customer");
      const p = await mkProduct(sql, 80);
      await asUser(
        sql,
        a,
        (tx) => tx`INSERT INTO public.wishlist_items (user_id, product_id) VALUES (${a}, ${p})`,
      );
      expect(
        await asUser(sql, a, (tx) => tx`SELECT product_id FROM public.wishlist_items`),
      ).toHaveLength(1);
      expect(
        await asUser(sql, b, (tx) => tx`SELECT product_id FROM public.wishlist_items`),
      ).toHaveLength(0);

      const forged = await attempt(
        asUser(
          sql,
          b,
          (tx) => tx`INSERT INTO public.wishlist_items (user_id, product_id) VALUES (${a}, ${p})`,
        ),
      );
      expect(forged.ok).toBe(false);
      await asUser(sql, b, (tx) => tx`DELETE FROM public.wishlist_items WHERE user_id = ${a}`);
      expect(
        await val(sql`SELECT count(*)::int FROM public.wishlist_items WHERE user_id = ${a}`),
      ).toBe(1);
      await asUser(sql, a, (tx) => tx`DELETE FROM public.wishlist_items WHERE product_id = ${p}`);
      expect(
        await val(sql`SELECT count(*)::int FROM public.wishlist_items WHERE user_id = ${a}`),
      ).toBe(0);
      expect((await attempt(asAnon(sql, (tx) => tx`SELECT * FROM public.wishlist_items`))).ok).toBe(
        false,
      );
    });

    it("rejects inactive products and duplicate saves", async () => {
      const a = await mkUser(sql, "customer");
      const p = await mkProduct(sql, 80);
      await sql`UPDATE public.products SET is_active = false WHERE id = ${p}`;
      const inactive = await attempt(
        asUser(
          sql,
          a,
          (tx) => tx`INSERT INTO public.wishlist_items (user_id, product_id) VALUES (${a}, ${p})`,
        ),
      );
      expect(inactive.ok).toBe(false);
      const q = await mkProduct(sql, 80);
      await asUser(
        sql,
        a,
        (tx) => tx`INSERT INTO public.wishlist_items (user_id, product_id) VALUES (${a}, ${q})`,
      );
      const dup = await attempt(
        asUser(
          sql,
          a,
          (tx) => tx`INSERT INTO public.wishlist_items (user_id, product_id) VALUES (${a}, ${q})`,
        ),
      );
      expect(dup.ok).toBe(false);
    });

    it("only accepts back-in-stock subscriptions for sold-out products, own rows only", async () => {
      const a = await mkUser(sql, "customer");
      const b = await mkUser(sql, "customer");
      const p = await mkProduct(sql, 60);
      await receive(sql, manager, p, 3);
      const inStock = await attempt(
        asUser(
          sql,
          a,
          (tx) =>
            tx`INSERT INTO public.back_in_stock_subscriptions (user_id, product_id) VALUES (${a}, ${p})`,
        ),
      );
      expect(!inStock.ok && inStock.message).toContain("product_in_stock");

      const soldOut = await mkProduct(sql, 60); // no batches => unavailable
      await asUser(
        sql,
        a,
        (tx) =>
          tx`INSERT INTO public.back_in_stock_subscriptions (user_id, product_id) VALUES (${a}, ${soldOut})`,
      );
      const dup = await attempt(
        asUser(
          sql,
          a,
          (tx) =>
            tx`INSERT INTO public.back_in_stock_subscriptions (user_id, product_id) VALUES (${a}, ${soldOut})`,
        ),
      );
      expect(dup.ok).toBe(false);
      const forged = await attempt(
        asUser(
          sql,
          b,
          (tx) =>
            tx`INSERT INTO public.back_in_stock_subscriptions (user_id, product_id) VALUES (${a}, ${soldOut})`,
        ),
      );
      expect(forged.ok).toBe(false);
      const other = await mkProduct(sql, 5);
      const setStatus = await attempt(
        asUser(
          sql,
          a,
          (tx) =>
            tx`INSERT INTO public.back_in_stock_subscriptions (user_id, product_id, status) VALUES (${a}, ${other}, 'notified')`,
        ),
      );
      expect(setStatus.ok).toBe(false);
      expect(
        await asUser(sql, b, (tx) => tx`SELECT * FROM public.back_in_stock_subscriptions`),
      ).toHaveLength(0);
      const tamper = await attempt(
        asUser(
          sql,
          a,
          (tx) =>
            tx`UPDATE public.back_in_stock_subscriptions SET status = 'notified' WHERE user_id = ${a}`,
        ),
      );
      expect(tamper.ok).toBe(false);
    });

    it("hands each due subscription to exactly one notifier once stock returns", async () => {
      const a = await mkUser(sql, "customer");
      const p = await mkProduct(sql, 60);
      await asUser(
        sql,
        a,
        (tx) =>
          tx`INSERT INTO public.back_in_stock_subscriptions (user_id, product_id) VALUES (${a}, ${p})`,
      );
      const none = await rpc(sql, "claim_back_in_stock_notifications", 50);
      expect(none.filter((r: any) => r.product_id === p)).toHaveLength(0);

      await receive(sql, manager, p, 5);
      const claims = await Promise.all(
        Array.from({ length: 6 }, () => rpc(sql, "claim_back_in_stock_notifications", 50)),
      );
      const mine = claims.flat().filter((r: any) => r.product_id === p);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ user_id: a });
      const [s] =
        await sql`SELECT status, notified_at FROM public.back_in_stock_subscriptions WHERE user_id = ${a}`;
      expect(s!["status"]).toBe("notified");
      expect(s!["notified_at"]).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("reorder revalidation", () => {
    async function pastOrder(customer: string, price = 100, qty = 2, stock = 10) {
      const product = await mkProduct(sql, price);
      await receive(sql, manager, product, stock);
      const { orderId, total } = await placeOrder(sql, customer, [
        { product_id: product, quantity: qty },
      ]);
      await advanceOrder(sql, manager, orderId, "completed");
      return { product, orderId, total };
    }

    it("reports ok lines and the current total", async () => {
      const c = await mkUser(sql, "customer");
      const { orderId, total } = await pastOrder(c);
      const check = await rpc(sql, "reorder_check", c, orderId);
      expect(check).toMatchObject({ orderable: true, current_total: total });
      expect(check.lines[0]).toMatchObject({ status: "ok", quantity: 2 });
    });

    it("creates a new order at CURRENT prices and holds stock", async () => {
      const c = await mkUser(sql, "customer");
      const { product, orderId } = await pastOrder(c, 100, 2, 10);
      await sql`UPDATE public.products SET price_rand = 120 WHERE id = ${product}`;
      const check = await rpc(sql, "reorder_check", c, orderId);
      expect(check.lines[0]).toMatchObject({
        status: "price_changed",
        previous_price: 100,
        current_price: 120,
      });
      expect(Number(check.current_total)).toBe(240);

      const r = await rpc(sql, "create_reorder", c, orderId, 240, key("ro"));
      expect(r).toMatchObject({ total: 240, source_order_id: orderId, status: "awaiting_payment" });
      expect(r.order_id).not.toBe(orderId);
      const [o] = await sql`SELECT user_id, notes FROM public.orders WHERE id = ${r.order_id}`;
      expect(o!["user_id"]).toBe(c);
      expect(o!["notes"]).toContain("Reorder of");
      expect(
        await val(
          sql`SELECT COALESCE(sum(quantity),0)::int FROM public.stock_reservations WHERE order_id = ${r.order_id} AND status = 'held'`,
        ),
      ).toBe(2);
    });

    it("refuses to create anything when the price moved since the member confirmed", async () => {
      const c = await mkUser(sql, "customer");
      const { product, orderId, total } = await pastOrder(c);
      await sql`UPDATE public.products SET price_rand = 150 WHERE id = ${product}`;
      const before = await val(sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${c}`);
      const r = await attempt(rpc(sql, "create_reorder", c, orderId, total, key("ro")));
      expect(failedWith(r, "price_changed")).toBe(true);
      expect(await val(sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${c}`)).toBe(
        before,
      );
      const missing = await attempt(rpc(sql, "create_reorder", c, orderId, null, key("ro")));
      expect(failedWith(missing, "expected_total_required")).toBe(true);
    });

    it("refuses when stock is short or the product was retired", async () => {
      const c = await mkUser(sql, "customer");
      const short = await pastOrder(c, 100, 4, 5); // 1 left after the order
      const check = await rpc(sql, "reorder_check", c, short.orderId);
      expect(check).toMatchObject({ orderable: false, current_total: null });
      expect(check.lines[0]).toMatchObject({ status: "insufficient_stock", available: 1 });
      const r = await attempt(rpc(sql, "create_reorder", c, short.orderId, 400, key("ro")));
      expect(failedWith(r, "reorder_unavailable")).toBe(true);

      const retired = await pastOrder(c);
      await sql`UPDATE public.products SET is_active = false WHERE id = ${retired.product}`;
      expect((await rpc(sql, "reorder_check", c, retired.orderId)).lines[0].status).toBe(
        "unavailable",
      );
      const r2 = await attempt(
        rpc(sql, "create_reorder", c, retired.orderId, retired.total, key("ro")),
      );
      expect(failedWith(r2, "reorder_unavailable")).toBe(true);
    });

    it("is idempotent per key and ownership-checked", async () => {
      const c = await mkUser(sql, "customer");
      const other = await mkUser(sql, "customer");
      const { orderId, total } = await pastOrder(c);
      const k = key("ro");
      const first = await rpc(sql, "create_reorder", c, orderId, total, k);
      const replays = await Promise.all(
        Array.from({ length: 5 }, () => rpc(sql, "create_reorder", c, orderId, total, k)),
      );
      for (const r of replays) expect(r.order_id).toBe(first.order_id);
      expect(
        await val(
          sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${c} AND notes LIKE 'Reorder of%'`,
        ),
      ).toBe(1);

      expect(
        failedWith(await attempt(rpc(sql, "reorder_check", other, orderId)), "order_not_found"),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(rpc(sql, "create_reorder", other, orderId, total, key("ro"))),
          "order_not_found",
        ),
      ).toBe(true);
    });

    it("never oversells when two reorders race for the last units", async () => {
      const c = await mkUser(sql, "customer");
      const d = await mkUser(sql, "customer");
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 4);
      const mk = async (u: string) => {
        const { orderId, total } = await placeOrder(sql, u, [{ product_id: product, quantity: 2 }]);
        await advanceOrder(sql, manager, orderId, "completed");
        return { orderId, total };
      };
      const [oc, od] = [await mk(c), await mk(d)];
      await receive(sql, manager, product, 2); // exactly enough for ONE more order of 2
      const results = await Promise.all([
        attempt(rpc(sql, "create_reorder", c, oc.orderId, oc.total, key("ro"))),
        attempt(rpc(sql, "create_reorder", d, od.orderId, od.total, key("ro"))),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    });
  });
});
