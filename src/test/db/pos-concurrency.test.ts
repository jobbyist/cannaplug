import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  attempt,
  card,
  cash,
  connect,
  failedWith,
  key,
  mkProduct,
  mkSession,
  mkUser,
  receive,
  rpc,
  sell,
  stockOf,
  assertInventoryConsistent,
  uid,
  val,
  type Sql,
} from "./helpers";

/**
 * Concurrency evidence for Milestone 3. Every scenario fires genuinely simultaneous requests over
 * separate PostgreSQL connections and then asserts BOTH the business outcome and the global
 * invariant  0 <= held <= on_hand  and  counters == ledger / reservations  (afterEach).
 */
describe.skipIf(!DB_URL)("POS & atomic inventory — concurrency (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;

  beforeAll(async () => {
    sql = connect(60);
    // Warm the pool so "simultaneous" requests really overlap (cold connects would stagger them).
    await Promise.all(Array.from({ length: 60 }, () => sql`SELECT pg_sleep(0.2)`));
    manager = await mkUser(sql, "manager");
    cashier = await mkUser(sql, "budtender");
  });
  afterAll(async () => {
    await sql.end();
  });
  afterEach(async () => {
    await assertInventoryConsistent(sql);
  });

  const fresh = async (price = 50, qty = 1) => {
    const product = await mkProduct(sql, price);
    await receive(sql, manager, product, qty);
    const { sessionId } = await mkSession(sql, manager, cashier);
    return { product, sessionId };
  };
  const oneOf = (product: string, quantity = 1) => [{ product_id: product, quantity }];

  describe("negative control: the naive pattern DOES oversell on this harness", () => {
    it("SELECT-then-UPDATE without locking or a CHECK sells the last unit many times", async () => {
      await sql`CREATE TABLE IF NOT EXISTS public.naive_stock (id uuid PRIMARY KEY, qty int NOT NULL)`;
      const id = uid();
      await sql`INSERT INTO public.naive_stock VALUES (${id}, 1)`;
      const naiveSell = async () => {
        await sql.begin(async (tx) => {
          const [row] = await tx`SELECT qty FROM public.naive_stock WHERE id = ${id}`;
          if (row!["qty"] < 1) throw new Error("sold out");
          await tx`SELECT pg_sleep(0.05)`; // widen the read-modify-write window
          await tx`UPDATE public.naive_stock SET qty = ${row!["qty"] - 1} WHERE id = ${id}`;
        });
      };
      const results = await Promise.all(Array.from({ length: 10 }, () => attempt(naiveSell())));
      const sold = results.filter((r) => r.ok).length;
      expect(sold).toBeGreaterThan(1); // the race is real: more than the single available unit "sold"
      await sql`DROP TABLE public.naive_stock`;
    });
  });

  describe("last-unit races", () => {
    it("20 simultaneous POS sales for the last unit: exactly one wins, no negative stock", async () => {
      const { product, sessionId } = await fresh(50, 1);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          attempt(sell(sql, cashier, sessionId, oneOf(product), [cash("50")])),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => failedWith(r, "insufficient_stock"))).toHaveLength(19);
      expect(await stockOf(sql, product)).toMatchObject({
        on_hand: 0,
        held: 0,
        available: 0,
        consumed: 1,
      });
      const n = await val(
        sql`SELECT count(*)::int n FROM public.pos_sale_items WHERE product_id = ${product}`,
      );
      expect(n).toBe(1);
      const tenders = await val(sql`
        SELECT count(*)::int tenders FROM public.pos_tenders t
        JOIN public.pos_sale_items i ON i.sale_id = t.sale_id WHERE i.product_id = ${product}`);
      expect(tenders).toBe(1); // failed attempts left no orphan financial rows
    });

    it("stock 5, 30 simultaneous sales of 1: exactly 5 succeed", async () => {
      const { product, sessionId } = await fresh(20, 5);
      const results = await Promise.all(
        Array.from({ length: 30 }, () =>
          attempt(sell(sql, cashier, sessionId, oneOf(product), [cash("20")])),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(5);
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 0, consumed: 5 });
    });

    it("multi-batch FEFO: a sale spanning batches is atomic — partial availability sells nothing", async () => {
      const product = await mkProduct(sql, 10);
      await receive(sql, manager, product, 2, "EARLY", new Date(Date.now() + 86_400_000));
      await receive(sql, manager, product, 3, "LATE", new Date(Date.now() + 5 * 86_400_000));
      const { sessionId } = await mkSession(sql, manager, cashier);
      const tooMany = await attempt(sell(sql, cashier, sessionId, oneOf(product, 6), [cash("60")]));
      expect(failedWith(tooMany, "insufficient_stock")).toBe(true);
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 5, consumed: 0 });
      await sell(sql, cashier, sessionId, oneOf(product, 4), [cash("40")]);
      const batches =
        await sql`SELECT batch_code, qty_on_hand FROM public.inventory_batches WHERE product_id = ${product} ORDER BY batch_code`;
      expect(Object.fromEntries(batches.map((b) => [b["batch_code"], b["qty_on_hand"]]))).toEqual({
        EARLY: 0,
        LATE: 1,
      }); // earliest expiry first
    });

    it("online reservation vs POS sale racing for the last unit: only one gets it", async () => {
      for (let round = 0; round < 8; round++) {
        const { product, sessionId } = await fresh(50, 1);
        const customer = await mkUser(sql, "customer");
        const [online, pos] = await Promise.all([
          attempt(
            rpc(
              sql,
              "create_online_order",
              customer,
              [{ product_id: product, quantity: 1 }],
              "C",
              "0820000000",
              null,
              key("ord"),
              30,
            ),
          ),
          attempt(sell(sql, cashier, sessionId, oneOf(product), [cash("50")])),
        ]);
        expect([online.ok, pos.ok].filter(Boolean)).toHaveLength(1);
        const s = await stockOf(sql, product);
        expect(s.held + s.consumed).toBe(1);
        expect(s.available).toBe(0);
      }
    });

    it("10 customers racing to hold the last 2 units online: exactly 2 orders succeed", async () => {
      const product = await mkProduct(sql, 80);
      await receive(sql, manager, product, 2);
      const customers = await Promise.all(
        Array.from({ length: 10 }, () => mkUser(sql, "customer")),
      );
      const results = await Promise.all(
        customers.map((c) =>
          attempt(
            rpc(
              sql,
              "create_online_order",
              c,
              [{ product_id: product, quantity: 1 }],
              "C",
              "0820000000",
              null,
              key("ord"),
              30,
            ),
          ),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(2);
      expect(results.filter((r) => failedWith(r, "insufficient_stock"))).toHaveLength(8);
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 2, held: 2, available: 0 });
      // Failed attempts must not leave orphan orders behind.
      const n = await val(
        sql`SELECT count(*)::int n FROM public.order_items WHERE product_id = ${product}`,
      );
      expect(n).toBe(2);
    });
  });

  describe("duplicate network requests and retries", () => {
    it("12 simultaneous duplicates of the SAME request create exactly one sale", async () => {
      const { product, sessionId } = await fresh(50, 10);
      const idem = key("dup");
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          attempt(sell(sql, cashier, sessionId, oneOf(product, 2), [cash("100")], { idem })),
        ),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      const values = results.map((r) => (r as any).value);
      expect(new Set(values.map((v) => v.sale_id)).size).toBe(1);
      expect(values.filter((v) => !v.replayed)).toHaveLength(1);
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 8, consumed: 2 });
      const n = await val(
        sql`SELECT count(*)::int n FROM public.pos_sales WHERE id = ${values[0].sale_id}`,
      );
      expect(n).toBe(1);
    });

    it("a retry after the response is lost returns the stored receipt, without a second charge", async () => {
      const { product, sessionId } = await fresh(50, 3);
      const idem = key("lost");
      const first = await sell(sql, cashier, sessionId, oneOf(product), [cash("50")], { idem });
      const retry = await sell(sql, cashier, sessionId, oneOf(product), [cash("50")], { idem });
      expect(retry).toMatchObject({
        sale_id: first.sale_id,
        receipt_number: first.receipt_number,
        replayed: true,
      });
      expect((await stockOf(sql, product)).on_hand).toBe(2);
    });

    it("re-using a key with a DIFFERENT payload is rejected, not silently replayed", async () => {
      const { product, sessionId } = await fresh(50, 5);
      const idem = key("reuse");
      await sell(sql, cashier, sessionId, oneOf(product, 1), [cash("50")], { idem });
      const r = await attempt(
        sell(sql, cashier, sessionId, oneOf(product, 2), [cash("100")], { idem }),
      );
      expect(failedWith(r, "idempotency_conflict")).toBe(true);
      expect((await stockOf(sql, product)).on_hand).toBe(4);
    });

    it("a FAILED attempt does not poison its key: the retry succeeds once stock exists", async () => {
      const { product, sessionId } = await fresh(50, 1);
      const idem = key("poison");
      const fail = await attempt(
        sell(sql, cashier, sessionId, oneOf(product, 3), [cash("150")], { idem }),
      );
      expect(failedWith(fail, "insufficient_stock")).toBe(true);
      const n = await val(
        sql`SELECT count(*)::int n FROM public.operation_idempotency WHERE key LIKE ${"%:" + idem}`,
      );
      expect(n).toBe(0); // rolled back with the failed transaction
      await receive(sql, manager, product, 5);
      const ok = await attempt(
        sell(sql, cashier, sessionId, oneOf(product, 3), [cash("150")], { idem }),
      );
      expect(ok.ok).toBe(true);
    });

    it("idempotency keys are namespaced per actor (no cross-cashier replay leak)", async () => {
      const { product, sessionId } = await fresh(50, 5);
      const other = await mkUser(sql, "manager"); // may ring on any session
      const idem = key("shared");
      const a = await sell(sql, cashier, sessionId, oneOf(product), [cash("50")], { idem });
      const b = await sell(sql, other, sessionId, oneOf(product), [cash("50")], { idem });
      expect(b.sale_id).not.toBe(a.sale_id);
      expect(b.replayed).toBeUndefined();
    });

    it("the same card slip cannot back two sales — sequentially or simultaneously", async () => {
      const { product, sessionId } = await fresh(50, 10);
      const ref = `RRN-${uid().slice(0, 12)}`;
      await sell(sql, cashier, sessionId, oneOf(product), [card("50", ref)]);
      const again = await attempt(sell(sql, cashier, sessionId, oneOf(product), [card("50", ref)]));
      expect(failedWith(again, "payment_reference_in_use")).toBe(true);

      const ref2 = `RRN-${uid().slice(0, 12)}`;
      const race = await Promise.all(
        Array.from({ length: 6 }, () =>
          attempt(sell(sql, cashier, sessionId, oneOf(product), [card("50", ref2)])),
        ),
      );
      expect(race.filter((r) => r.ok)).toHaveLength(1);
      expect((await stockOf(sql, product)).on_hand).toBe(8); // exactly two of the eight attempts sold
    });
  });

  describe("server-side totals and tenders (nothing client-controlled is trusted)", () => {
    it("ignores client prices/totals and rejects tender sums that differ from the server total", async () => {
      const { product, sessionId } = await fresh(50, 5);
      const cheat = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 2, unit_price: 1, total: 2 }],
        [cash("2")],
      ).catch((e) => e);
      expect(String(cheat.message)).toMatch(/^tender_mismatch/);
      const short = await attempt(
        sell(sql, cashier, sessionId, oneOf(product, 2), [cash("99.99")]),
      );
      const over = await attempt(
        sell(sql, cashier, sessionId, oneOf(product, 2), [cash("100.01")]),
      );
      expect(failedWith(short, "tender_mismatch")).toBe(true);
      expect(failedWith(over, "tender_mismatch")).toBe(true);
      expect((await stockOf(sql, product)).on_hand).toBe(5); // nothing deducted by any rejected attempt
    });

    it("accepts a split multi-tender sale (cash + card + eft + paypal) that sums exactly", async () => {
      const { product, sessionId } = await fresh(100, 3);
      const sale = await sell(sql, cashier, sessionId, oneOf(product, 3), [
        cash("100.50"),
        card("99.50", `C-${uid().slice(0, 10)}`),
        { method: "eft", amount: "50", reference: `EFT-${uid().slice(0, 10)}` },
        { method: "paypal", amount: "50", reference: `PP-${uid().slice(0, 10)}` },
      ]);
      expect(Number(sale.total)).toBe(300);
      expect(sale.tenders).toHaveLength(4);
    });

    it.each([
      ["zero tender", [cash("0")]],
      ["negative tender", [cash("-50")]],
      ["3-decimal tender", [cash("50.001")]],
      ["scientific notation", [cash("5e1")]],
      ["unknown method", [{ method: "bitcoin", amount: "50", reference: "abcd1234" }]],
      ["card without reference", [{ method: "card", amount: "50" }]],
      ["cash with a reference", [{ method: "cash", amount: "50", reference: "abcd1234" }]],
      ["no tenders", []],
    ])("rejects %s", async (_label, tenders) => {
      const { product, sessionId } = await fresh(50, 2);
      const r = await attempt(sell(sql, cashier, sessionId, oneOf(product), tenders as unknown[]));
      expect(r.ok).toBe(false);
      expect((await stockOf(sql, product)).on_hand).toBe(2);
    });

    it.each([
      ["zero quantity", [{ quantity: 0 }]],
      ["negative quantity", [{ quantity: -1 }]],
      ["fractional quantity", [{ quantity: 1.5 }]],
      ["absurd quantity", [{ quantity: 100000 }]],
      ["empty basket", []],
    ])("rejects %s", async (_label, items) => {
      const { product, sessionId } = await fresh(50, 2);
      const payload = (items as { quantity: number }[]).map((i) => ({ product_id: product, ...i }));
      const r = await attempt(sell(sql, cashier, sessionId, payload, [cash("50")]));
      expect(r.ok).toBe(false);
      expect((await stockOf(sql, product)).on_hand).toBe(2);
    });

    it("rejects inactive products and unknown products", async () => {
      const { product, sessionId } = await fresh(50, 2);
      await sql`UPDATE public.products SET is_active = false WHERE id = ${product}`;
      expect(
        failedWith(
          await attempt(sell(sql, cashier, sessionId, oneOf(product), [cash("50")])),
          "product_unavailable",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(sell(sql, cashier, sessionId, oneOf(uid()), [cash("50")])),
          "product_unavailable",
        ),
      ).toBe(true);
    });

    it("merges duplicate lines of one product and prices them once each", async () => {
      const { product, sessionId } = await fresh(30, 5);
      const sale = await sell(
        sql,
        cashier,
        sessionId,
        [
          { product_id: product, quantity: 1 },
          { product_id: product, quantity: 2 },
        ],
        [cash("90")],
      );
      expect(Number(sale.total)).toBe(90);
      expect(sale.items).toHaveLength(1);
    });

    it("a price change mid-sale cannot produce a total different from the tender check", async () => {
      const { product, sessionId } = await fresh(50, 20);
      const results = await Promise.all([
        ...Array.from({ length: 8 }, () =>
          attempt(sell(sql, cashier, sessionId, oneOf(product), [cash("50")])),
        ),
        attempt(
          sql`UPDATE public.products SET price_rand = 60 WHERE id = ${product}`.then(
            () => "repriced",
          ),
        ),
      ]);
      const sold = results.slice(0, 8).filter((r) => r.ok).length;
      const total =
        await sql`SELECT COALESCE(SUM(total),0)::numeric t FROM public.pos_sales s JOIN public.pos_sale_items i ON i.sale_id = s.id WHERE i.product_id = ${product}`;
      // Each committed sale reconciled at whichever price it locked; the deferred trigger enforced it.
      expect(Number(total[0]!["t"])).toBe(sold * 50);
    });
  });

  describe("deadlock freedom", () => {
    it("40 concurrent multi-product sales with opposite item orders never deadlock", async () => {
      const a = await mkProduct(sql, 10);
      const b = await mkProduct(sql, 10);
      await receive(sql, manager, a, 100);
      await receive(sql, manager, b, 100);
      const { sessionId } = await mkSession(sql, manager, cashier);
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          attempt(
            sell(
              sql,
              cashier,
              sessionId,
              i % 2
                ? [
                    { product_id: a, quantity: 1 },
                    { product_id: b, quantity: 1 },
                  ]
                : [
                    { product_id: b, quantity: 1 },
                    { product_id: a, quantity: 1 },
                  ],
              [cash("20")],
            ),
          ),
        ),
      );
      const deadlocks = results.filter((r) => !r.ok && r.code === "40P01");
      expect(deadlocks).toHaveLength(0);
      expect(results.every((r) => r.ok)).toBe(true);
      expect((await stockOf(sql, a)).on_hand).toBe(60);
    });
  });

  describe("till close vs concurrent sale recording", () => {
    it("expected cash always equals the cash of exactly the sales that committed before close", async () => {
      for (let round = 0; round < 6; round++) {
        const product = await mkProduct(sql, 50);
        await receive(sql, manager, product, 200);
        const { sessionId } = await mkSession(sql, manager, cashier, 300);
        const sales = Array.from({ length: 16 }, () =>
          attempt(sell(sql, cashier, sessionId, oneOf(product), [cash("50")])),
        );
        const close = attempt(
          (async () => {
            await new Promise((r) => setTimeout(r, Math.random() * 15));
            return rpc(sql, "pos_close_session", cashier, sessionId, 1000, null, key("close"));
          })(),
        );
        const [closed, ...saleResults] = await Promise.all([close, ...sales]);
        expect(closed.ok).toBe(true);
        const committed = saleResults.filter((r) => r.ok).length;
        const rejected = saleResults.filter((r) => failedWith(r, "session_closed")).length;
        expect(committed + rejected).toBe(16); // every sale either committed or was cleanly refused
        const c = (closed as any).value;
        expect(Number(c.expected_cash)).toBe(300 + committed * 50);
        expect(c.sales_count).toBe(committed);
        const late = await val(sql`
          SELECT count(*)::int late FROM public.pos_sales s JOIN public.pos_sessions p ON p.id = s.session_id
          WHERE s.session_id = ${sessionId} AND s.created_at > p.closed_at`);
        expect(late).toBe(0); // nothing recorded after the till was closed
      }
    });

    it("double-close (duplicate request) yields one close; a second cashier attempt is refused", async () => {
      const { sessionId } = await fresh(50, 1);
      const idem = key("close");
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          attempt(rpc(sql, "pos_close_session", cashier, sessionId, 500, null, idem)),
        ),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(new Set(results.map((r) => (r as any).value.closed_at ?? "x")).size).toBe(1);
      const other = await attempt(
        rpc(sql, "pos_close_session", cashier, sessionId, 500, null, key("close2")),
      );
      expect(failedWith(other, "session_closed")).toBe(true);
      const n = await val(
        sql`SELECT count(*)::int n FROM public.audit_log WHERE action = 'pos_session_closed' AND entity_id = ${sessionId}`,
      );
      expect(n).toBe(1);
    });

    it("only one session may be open per drawer, even when opened simultaneously", async () => {
      const d = await rpc(
        sql,
        "pos_upsert_drawer",
        manager,
        null,
        `Till ${uid().slice(0, 8)}`,
        null,
        true,
      );
      const cashiers = await Promise.all(Array.from({ length: 6 }, () => mkUser(sql, "budtender")));
      const results = await Promise.all(
        cashiers.map((c) =>
          attempt(rpc(sql, "pos_open_session", c, d.drawer_id, 100, key("open"))),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => failedWith(r, "drawer_already_open"))).toHaveLength(5);
    });

    it("variance beyond tolerance needs approval by someone other than the cashier", async () => {
      const { sessionId } = await fresh(50, 1);
      const closed = await rpc(
        sql,
        "pos_close_session",
        cashier,
        sessionId,
        470,
        "short",
        key("close"),
      ); // expected 500
      expect(Number(closed.variance)).toBe(-30);
      expect(closed.approval_status).toBe("pending");
      expect(
        failedWith(
          await attempt(rpc(sql, "pos_review_session", cashier, sessionId, true, "self")),
          "forbidden",
        ),
      ).toBe(true);
      const budtenderOnly = await mkUser(sql, "budtender");
      expect(
        failedWith(
          await attempt(rpc(sql, "pos_review_session", budtenderOnly, sessionId, true, "nope")),
          "forbidden",
        ),
      ).toBe(true);
      const approved = await rpc(
        sql,
        "pos_review_session",
        manager,
        sessionId,
        true,
        "recount agreed",
      );
      expect(approved.approval_status).toBe("approved");
      expect(
        failedWith(
          await attempt(rpc(sql, "pos_review_session", manager, sessionId, false, "again")),
          "not_pending",
        ),
      ).toBe(true);
    });

    it("within-tolerance variance needs no approval; a closed count cannot be rewritten", async () => {
      const { sessionId } = await fresh(50, 1);
      const closed = await rpc(
        sql,
        "pos_close_session",
        cashier,
        sessionId,
        505,
        null,
        key("close"),
      );
      expect(closed.approval_status).toBe("not_required");
      const tamper = await attempt(
        sql`UPDATE public.pos_sessions SET actual_cash = 500 WHERE id = ${sessionId}`,
      );
      expect(tamper.ok).toBe(false);
    });
  });

  describe("voids, refunds and audit events", () => {
    it("concurrent full refunds of the same lines: exactly one wins, no over-refund, no double restock", async () => {
      const { product, sessionId } = await fresh(50, 5);
      const ref = `C-${uid().slice(0, 10)}`;
      const sale = await sell(sql, cashier, sessionId, oneOf(product, 2), [card("100", ref)]);
      const [item] =
        await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${sale.sale_id}`;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          attempt(
            rpc(
              sql,
              "pos_refund_sale",
              manager,
              sale.sale_id,
              sessionId,
              [{ sale_item_id: item!["id"], quantity: 2 }],
              [{ method: "card", amount: "100" }],
              "customer returned",
              true,
              key("rf"),
            ),
          ),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(
        results.filter((r) => failedWith(r, "over_refund") || failedWith(r, "invalid_sale_state")),
      ).toHaveLength(7);
      expect((await stockOf(sql, product)).on_hand).toBe(5); // restocked exactly once
      const total = await val(
        sql`SELECT COALESCE(SUM(amount),0)::numeric total FROM public.pos_refunds WHERE sale_id = ${sale.sale_id}`,
      );
      expect(Number(total)).toBe(100);
    });

    it("refund and void racing on one sale: exactly one financial reversal", async () => {
      for (let round = 0; round < 6; round++) {
        const { product, sessionId } = await fresh(50, 3);
        const sale = await sell(sql, cashier, sessionId, oneOf(product, 1), [cash("50")]);
        const [item] =
          await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${sale.sale_id}`;
        const [refund, voided] = await Promise.all([
          attempt(
            rpc(
              sql,
              "pos_refund_sale",
              manager,
              sale.sale_id,
              sessionId,
              [{ sale_item_id: item!["id"], quantity: 1 }],
              [{ method: "cash", amount: "50" }],
              "changed mind",
              true,
              key("rf"),
            ),
          ),
          attempt(rpc(sql, "pos_void_sale", manager, sale.sale_id, "cashier error", key("vd"))),
        ]);
        expect([refund.ok, voided.ok].filter(Boolean)).toHaveLength(1);
        expect((await stockOf(sql, product)).on_hand).toBe(3); // returned once, never twice
      }
    });

    it("partial refunds accumulate correctly and cap at the tendered amount per method", async () => {
      const { product, sessionId } = await fresh(40, 5);
      const sale = await sell(sql, cashier, sessionId, oneOf(product, 3), [
        cash("60"),
        card("60", `C-${uid().slice(0, 10)}`),
      ]);
      const [item] =
        await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${sale.sale_id}`;
      const line = (q: number) => [{ sale_item_id: item!["id"], quantity: q }];
      const refund = (q: number, payouts: unknown[], reason = "partial return") =>
        attempt(
          rpc(
            sql,
            "pos_refund_sale",
            manager,
            sale.sale_id,
            sessionId,
            line(q),
            payouts,
            reason,
            true,
            key("rf"),
          ),
        );

      const r1 = await refund(1, [{ method: "cash", amount: "40" }]);
      expect(r1.ok && r1.value.status).toBe("partially_refunded");
      // 40 cash already refunded of 60 tendered: another 40 cash would exceed the cash tender.
      expect(failedWith(await refund(1, [{ method: "cash", amount: "40" }]), "over_refund")).toBe(
        true,
      );
      // Payouts must equal the SERVER-computed refund (1 x R40), never a client-chosen amount.
      expect(
        failedWith(await refund(1, [{ method: "card", amount: "39.99" }]), "refund_mismatch"),
      ).toBe(true);
      // A line can be split across methods, each capped by what that method tendered.
      const r2 = await refund(1, [
        { method: "cash", amount: "20" },
        { method: "card", amount: "20" },
      ]);
      expect(r2.ok).toBe(true);
      const r3 = await refund(1, [{ method: "card", amount: "40" }]);
      expect(r3.ok && r3.value.status).toBe("refunded");
      expect((await refund(1, [{ method: "card", amount: "40" }])).ok).toBe(false); // nothing left to refund
      const [tot] = await sql`
        SELECT COALESCE(SUM(po.amount),0)::numeric total FROM public.pos_refund_payouts po
        JOIN public.pos_refunds r ON r.id = po.refund_id WHERE r.sale_id = ${sale.sale_id}`;
      expect(Number(tot!["total"])).toBe(120); // exactly the sale total, no more
      const closed = await rpc(
        sql,
        "pos_close_session",
        cashier,
        sessionId,
        500,
        null,
        key("close"),
      );
      // float 500 + cash sale 60 - cash refunds (40 + 20) = 500
      expect(Number(closed.expected_cash)).toBe(500);
    });

    it("void restocks the exact batches, reverses loyalty and writes an audit event", async () => {
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 2, "V1");
      await receive(sql, manager, product, 3, "V2");
      const { sessionId } = await mkSession(sql, manager, cashier);
      const customer = await mkUser(sql, "customer");
      const sale = await sell(sql, cashier, sessionId, oneOf(product, 4), [cash("400")], {
        customer,
      });
      await rpc(sql, "accrue_pos_loyalty", sale.sale_id);
      const v = await rpc(sql, "pos_void_sale", manager, sale.sale_id, "wrong customer", key("vd"));
      expect(v.loyalty_reversed).toBe(40);
      const batches =
        await sql`SELECT batch_code, qty_on_hand FROM public.inventory_batches WHERE product_id = ${product} ORDER BY batch_code`;
      expect(batches.map((b) => b["qty_on_hand"])).toEqual([2, 3]);
      const [audit] =
        await sql`SELECT actor_user_id, metadata FROM public.audit_log WHERE action = 'pos_sale_voided' AND entity_id = ${sale.sale_id}`;
      expect(audit!["actor_user_id"]).toBe(manager);
      expect(audit!["metadata"]).toMatchObject({ reason: "wrong customer", total: 400 });
      const pts = await val(
        sql`SELECT COALESCE(SUM(points),0)::int pts FROM public.loyalty_ledger WHERE user_id = ${customer}`,
      );
      expect(pts).toBe(0);
      const again = await attempt(
        rpc(sql, "pos_void_sale", manager, sale.sale_id, "second void", key("vd")),
      );
      expect(failedWith(again, "invalid_sale_state")).toBe(true);
    });

    it("refund writes an audit event with actor, amount and method; voids need a manager", async () => {
      const { product, sessionId } = await fresh(50, 2);
      const sale = await sell(sql, cashier, sessionId, oneOf(product), [cash("50")]);
      const [item] =
        await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${sale.sale_id}`;
      expect(
        failedWith(
          await attempt(
            rpc(sql, "pos_void_sale", cashier, sale.sale_id, "cashier void", key("vd")),
          ),
          "forbidden",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(
            rpc(
              sql,
              "pos_refund_sale",
              cashier,
              sale.sale_id,
              sessionId,
              [{ sale_item_id: item!["id"], quantity: 1 }],
              [{ method: "cash", amount: "50" }],
              "x y z",
              false,
              key("rf"),
            ),
          ),
          "forbidden",
        ),
      ).toBe(true);
      await rpc(
        sql,
        "pos_refund_sale",
        manager,
        sale.sale_id,
        sessionId,
        [{ sale_item_id: item!["id"], quantity: 1 }],
        [{ method: "cash", amount: "50" }],
        "faulty product",
        true,
        key("rf"),
      );
      const [audit] =
        await sql`SELECT actor_user_id, metadata FROM public.audit_log WHERE action = 'pos_sale_refunded' AND entity_id = ${sale.sale_id}`;
      expect(audit!["actor_user_id"]).toBe(manager);
      expect(audit!["metadata"]).toMatchObject({ restocked: true, reason: "faulty product" });
    });

    it("a void needs a reason and an OPEN till session; a closed-session sale must be refunded instead", async () => {
      const { product, sessionId } = await fresh(50, 3);
      const sale = await sell(sql, cashier, sessionId, oneOf(product), [cash("50")]);
      expect(
        failedWith(
          await attempt(rpc(sql, "pos_void_sale", manager, sale.sale_id, "  ", key("vd"))),
          "reason_required",
        ),
      ).toBe(true);
      await rpc(sql, "pos_close_session", cashier, sessionId, 550, null, key("close"));
      expect(
        failedWith(
          await attempt(rpc(sql, "pos_void_sale", manager, sale.sale_id, "too late", key("vd"))),
          "session_closed",
        ),
      ).toBe(true);
    });
  });

  describe("manual stock adjustments", () => {
    it("are audited, need a reason, need a manager and can never drive stock negative or below held", async () => {
      const product = await mkProduct(sql, 50);
      const batch = await receive(sql, manager, product, 5, "ADJ");
      expect(
        failedWith(
          await attempt(rpc(sql, "adjust_stock", cashier, batch, -1, "shrinkage", key("adj"))),
          "forbidden",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(rpc(sql, "adjust_stock", manager, batch, -1, "", key("adj"))),
          "reason_required",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(rpc(sql, "adjust_stock", manager, batch, -6, "too many", key("adj"))),
          "insufficient_stock",
        ),
      ).toBe(true);
      const ok = await rpc(
        sql,
        "adjust_stock",
        manager,
        batch,
        -2,
        "damaged in storage",
        key("adj"),
      );
      expect(ok).toMatchObject({ before: 5, after: 3 });
      const [audit] =
        await sql`SELECT actor_user_id, metadata FROM public.audit_log WHERE action = 'stock_adjusted' AND entity_id = ${batch}`;
      expect(audit!["metadata"]).toMatchObject({
        delta: -2,
        reason: "damaged in storage",
        before: 5,
        after: 3,
      });

      // Held stock cannot be adjusted away.
      const customer = await mkUser(sql, "customer");
      await rpc(
        sql,
        "create_online_order",
        customer,
        [{ product_id: product, quantity: 2 }],
        "C",
        "0820000000",
        null,
        key("ord"),
        30,
      );
      const belowHeld = await attempt(
        rpc(sql, "adjust_stock", manager, batch, -2, "would break holds", key("adj")),
      );
      expect(failedWith(belowHeld, "insufficient_stock")).toBe(true);
    });

    it("20 simultaneous adjustments and sales can never push a batch below zero", async () => {
      const product = await mkProduct(sql, 10);
      const batch = await receive(sql, manager, product, 10);
      const { sessionId } = await mkSession(sql, manager, cashier);
      const ops = [
        ...Array.from({ length: 10 }, () =>
          attempt(rpc(sql, "adjust_stock", manager, batch, -1, "shrink", key("adj"))),
        ),
        ...Array.from({ length: 10 }, () =>
          attempt(sell(sql, cashier, sessionId, oneOf(product), [cash("10")])),
        ),
      ];
      const results = await Promise.all(ops);
      const succeeded = results.filter((r) => r.ok).length;
      expect(succeeded).toBe(10); // 10 units -> exactly 10 successful removals across both paths
      expect((await stockOf(sql, product)).on_hand).toBe(0);
    });

    it("duplicate adjustment requests apply once", async () => {
      const product = await mkProduct(sql, 10);
      const batch = await receive(sql, manager, product, 10);
      const idem = key("adj");
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          attempt(rpc(sql, "adjust_stock", manager, batch, -3, "audit count", idem)),
        ),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect((await stockOf(sql, product)).on_hand).toBe(7);
      const n = await val(
        sql`SELECT count(*)::int n FROM public.audit_log WHERE action = 'stock_adjusted' AND entity_id = ${batch}`,
      );
      expect(n).toBe(1);
    });
  });

  describe("loyalty accrual after commit", () => {
    it("10 simultaneous accrual calls (retries) credit the customer exactly once", async () => {
      const { product, sessionId } = await fresh(100, 5);
      const customer = await mkUser(sql, "customer");
      const sale = await sell(sql, cashier, sessionId, oneOf(product, 3), [cash("300")], {
        customer,
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, () => rpc(sql, "accrue_pos_loyalty", sale.sale_id)),
      );
      expect(results.filter((r) => r.accrued)).toHaveLength(1);
      expect(results.filter((r) => r.reason === "already_accrued")).toHaveLength(9);
      const pts = await val(
        sql`SELECT COALESCE(SUM(points),0)::int pts FROM public.loyalty_ledger WHERE user_id = ${customer}`,
      );
      expect(pts).toBe(30);
    });

    it("sale retries followed by accrual never double-credit", async () => {
      const { product, sessionId } = await fresh(100, 5);
      const customer = await mkUser(sql, "customer");
      const idem = key("retry");
      const all = await Promise.all(
        Array.from({ length: 6 }, async () => {
          const s = await sell(sql, cashier, sessionId, oneOf(product), [cash("100")], {
            customer,
            idem,
          });
          return rpc(sql, "accrue_pos_loyalty", s.sale_id);
        }),
      );
      expect(all.filter((r) => r.accrued)).toHaveLength(1);
      const pts = await val(
        sql`SELECT COALESCE(SUM(points),0)::int pts FROM public.loyalty_ledger WHERE user_id = ${customer}`,
      );
      expect(pts).toBe(10);
    });

    it("accrual is never part of the sale transaction: a rolled-back sale earns nothing", async () => {
      const { product, sessionId } = await fresh(100, 1);
      const customer = await mkUser(sql, "customer");
      const fail = await attempt(
        sell(sql, cashier, sessionId, oneOf(product, 5), [cash("500")], { customer }),
      );
      expect(fail.ok).toBe(false);
      const n = await val(
        sql`SELECT count(*)::int n FROM public.loyalty_ledger WHERE user_id = ${customer}`,
      );
      expect(n).toBe(0);
    });

    it("void racing accrual: points are never left standing for a voided sale", async () => {
      for (let round = 0; round < 8; round++) {
        const { product, sessionId } = await fresh(100, 2);
        const customer = await mkUser(sql, "customer");
        const sale = await sell(sql, cashier, sessionId, oneOf(product, 1), [cash("100")], {
          customer,
        });
        await Promise.all([
          attempt(rpc(sql, "accrue_pos_loyalty", sale.sale_id)),
          attempt(rpc(sql, "pos_void_sale", manager, sale.sale_id, "race", key("vd"))),
        ]);
        const pts = await val(
          sql`SELECT COALESCE(SUM(points),0)::int pts FROM public.loyalty_ledger WHERE user_id = ${customer}`,
        );
        expect(pts).toBe(0);
        const late = await rpc(sql, "accrue_pos_loyalty", sale.sale_id);
        expect(late.accrued).toBe(false);
      }
    });

    it("partial refund before accrual accrues on the net amount; after accrual it is reversed proportionally", async () => {
      const { product, sessionId } = await fresh(100, 10);
      const customer = await mkUser(sql, "customer");
      const sale = await sell(sql, cashier, sessionId, oneOf(product, 4), [cash("400")], {
        customer,
      });
      const [item] =
        await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${sale.sale_id}`;
      await rpc(sql, "accrue_pos_loyalty", sale.sale_id); // 40 pts
      await rpc(
        sql,
        "pos_refund_sale",
        manager,
        sale.sale_id,
        sessionId,
        [{ sale_item_id: item!["id"], quantity: 1 }],
        [{ method: "cash", amount: "100" }],
        "one returned",
        true,
        key("rf"),
      );
      const pts = await val(
        sql`SELECT COALESCE(SUM(points),0)::int pts FROM public.loyalty_ledger WHERE user_id = ${customer}`,
      );
      expect(pts).toBe(30);

      const sale2 = await sell(sql, cashier, sessionId, oneOf(product, 4), [cash("400")], {
        customer,
      });
      const [item2] =
        await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${sale2.sale_id}`;
      await rpc(
        sql,
        "pos_refund_sale",
        manager,
        sale2.sale_id,
        sessionId,
        [{ sale_item_id: item2!["id"], quantity: 1 }],
        [{ method: "cash", amount: "100" }],
        "before accrual",
        true,
        key("rf"),
      );
      const acc = await rpc(sql, "accrue_pos_loyalty", sale2.sale_id);
      expect(acc.points).toBe(30);
    });
  });

  describe("online orders: reservations, expiry, webhooks", () => {
    const mkOrder = async (product: string, qty = 1) => {
      const customer = await mkUser(sql, "customer");
      const o = await rpc(
        sql,
        "create_online_order",
        customer,
        [{ product_id: product, quantity: qty, unit_price: 0.01 }],
        "C",
        "0820000000",
        null,
        key("ord"),
        30,
      );
      return { customer, order: o };
    };

    it("prices the order server-side (client price ignored) and holds stock", async () => {
      const product = await mkProduct(sql, 75);
      await receive(sql, manager, product, 4);
      const { order } = await mkOrder(product, 2);
      expect(Number(order.total)).toBe(150);
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 4, held: 2, available: 2 });
    });

    it("customers can no longer insert orders / order lines directly with their own totals", async () => {
      const customer = await mkUser(sql, "customer");
      const attemptInsert = await attempt(
        sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE authenticated`;
          await tx`SELECT set_config('request.jwt.claim.sub', ${customer}, true)`;
          await tx`INSERT INTO public.orders (user_id, total_rand) VALUES (${customer}, 0.01)`;
        }),
      );
      expect(attemptInsert.ok).toBe(false);
      expect(attemptInsert.ok === false && attemptInsert.message).toMatch(/permission denied/);
    });

    it("8 simultaneous duplicate webhook deliveries confirm and consume exactly once", async () => {
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 3);
      const { order } = await mkOrder(product, 2);
      const event = `EV-${uid().slice(0, 12)}`;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          rpc(sql, "confirm_order_payment", "paypal", event, order.order_id, 200),
        ),
      );
      expect(results.filter((r) => !r.duplicate && r.outcome === "confirmed")).toHaveLength(1);
      expect(results.filter((r) => r.duplicate)).toHaveLength(7);
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 1, held: 0, consumed: 2 });
      const [o] = await sql`SELECT status FROM public.orders WHERE id = ${order.order_id}`;
      expect(o!["status"]).toBe("confirmed");
      const n = await val(
        sql`SELECT count(*)::int n FROM public.payment_events WHERE order_id = ${order.order_id}`,
      );
      expect(n).toBe(1);
    });

    it("two DIFFERENT payment events for one order (double capture): one confirms, one is flagged", async () => {
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 3);
      const { order } = await mkOrder(product, 1);
      const results = await Promise.all([
        rpc(
          sql,
          "confirm_order_payment",
          "paypal",
          `EV-${uid().slice(0, 12)}`,
          order.order_id,
          100,
        ),
        rpc(
          sql,
          "confirm_order_payment",
          "paypal",
          `EV-${uid().slice(0, 12)}`,
          order.order_id,
          100,
        ),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(["already_processed", "confirmed"]);
      expect((await stockOf(sql, product)).consumed).toBe(1);
    });

    it("wrong amounts never confirm; late payment on a cancelled order is flagged for refund", async () => {
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 3);
      const a = await mkOrder(product, 1);
      const wrong = await rpc(
        sql,
        "confirm_order_payment",
        "paypal",
        `EV-${uid().slice(0, 12)}`,
        a.order.order_id,
        99.99,
      );
      expect(wrong.outcome).toBe("amount_mismatch");
      expect((await stockOf(sql, product)).held).toBe(1);

      await rpc(
        sql,
        "transition_order_status",
        a.order.order_id,
        "cancelled",
        manager,
        "customer cancelled",
      );
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 3, held: 0, available: 3 });
      const late = await rpc(
        sql,
        "confirm_order_payment",
        "paypal",
        `EV-${uid().slice(0, 12)}`,
        a.order.order_id,
        100,
      );
      expect(late.outcome).toBe("paid_after_cancel_needs_refund");
      expect((await stockOf(sql, product)).consumed).toBe(0);
    });

    it("webhook racing a staff cancellation ends in one consistent state", async () => {
      for (let round = 0; round < 8; round++) {
        const product = await mkProduct(sql, 100);
        await receive(sql, manager, product, 2);
        const { order } = await mkOrder(product, 1);
        const [hook, cancel] = await Promise.all([
          attempt(
            rpc(
              sql,
              "confirm_order_payment",
              "paypal",
              `EV-${uid().slice(0, 12)}`,
              order.order_id,
              100,
            ),
          ),
          attempt(
            rpc(sql, "transition_order_status", order.order_id, "cancelled", manager, "race"),
          ),
        ]);
        const [o] = await sql`SELECT status FROM public.orders WHERE id = ${order.order_id}`;
        const s = await stockOf(sql, product);
        expect(s.held).toBe(0);
        if (o!["status"] === "confirmed") {
          expect(s.consumed).toBe(1);
        } else {
          expect(o!["status"]).toBe("cancelled");
          expect(s.consumed).toBe(0);
          expect(s.on_hand).toBe(2);
        }
        expect(hook.ok || cancel.ok).toBe(true);
      }
    });

    it("payment for an order whose hold expired re-reserves if stock remains, else is flagged for refund", async () => {
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 1);
      const { order } = await mkOrder(product, 1);
      await sql`ALTER TABLE public.stock_reservations DISABLE TRIGGER stock_reservations_guard`;
      await sql`UPDATE public.stock_reservations SET expires_at = now() - interval '1 hour' WHERE order_id = ${order.order_id}`;
      await sql`ALTER TABLE public.stock_reservations ENABLE TRIGGER stock_reservations_guard`;
      // Someone else buys the unit at the till: the expired hold is swept and the unit is sold.
      const { sessionId } = await mkSession(sql, manager, cashier);
      await sell(sql, cashier, sessionId, oneOf(product), [cash("100")]);
      const late = await rpc(
        sql,
        "confirm_order_payment",
        "paypal",
        `EV-${uid().slice(0, 12)}`,
        order.order_id,
        100,
      );
      expect(late.outcome).toBe("stock_unavailable_needs_refund");
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 0, held: 0 });
      const [r] =
        await sql`SELECT status FROM public.stock_reservations WHERE order_id = ${order.order_id}`;
      expect(r!["status"]).toBe("expired");
    });

    it("expiry sweep releases holds concurrently without double-decrementing", async () => {
      const product = await mkProduct(sql, 50);
      await receive(sql, manager, product, 6);
      const orders = await Promise.all(Array.from({ length: 3 }, () => mkOrder(product, 2)));
      await sql`ALTER TABLE public.stock_reservations DISABLE TRIGGER stock_reservations_guard`;
      await sql`UPDATE public.stock_reservations SET expires_at = now() - interval '1 hour' WHERE product_id = ${product}`;
      await sql`ALTER TABLE public.stock_reservations ENABLE TRIGGER stock_reservations_guard`;
      const swept = await Promise.all(
        Array.from({ length: 6 }, () => rpc<number>(sql, "release_expired_reservations")),
      );
      expect(swept.reduce((a, b) => a + Number(b), 0)).toBeGreaterThanOrEqual(3);
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 6, held: 0, available: 6 });
      expect(orders).toHaveLength(3);
    });
  });

  describe("database-level backstops (even for service_role / direct SQL)", () => {
    it("rejects a direct ledger write that would make stock negative", async () => {
      const product = await mkProduct(sql, 10);
      const batch = await receive(sql, manager, product, 1);
      const r =
        await attempt(sql`INSERT INTO public.inventory_ledger (batch_id, product_id, quantity_delta, reason, movement_type)
                                   VALUES (${batch}, ${product}, -2, 'rogue', 'adjustment')`);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.message).toMatch(
        /inventory_batches_on_hand_nonneg|violates check/,
      );
    });

    it("rejects over-holding and counter tampering", async () => {
      const product = await mkProduct(sql, 10);
      const batch = await receive(sql, manager, product, 2);
      expect(
        (await attempt(sql`UPDATE public.inventory_batches SET qty_held = 3 WHERE id = ${batch}`))
          .ok,
      ).toBe(false);
      expect(
        (
          await attempt(
            sql`UPDATE public.inventory_batches SET qty_on_hand = -1 WHERE id = ${batch}`,
          )
        ).ok,
      ).toBe(false);
    });

    it("keeps ledger, tenders, refunds, loyalty and payment events append-only", async () => {
      const { product, sessionId } = await fresh(50, 2);
      const customer = await mkUser(sql, "customer");
      const sale = await sell(sql, cashier, sessionId, oneOf(product), [cash("50")], { customer });
      await rpc(sql, "accrue_pos_loyalty", sale.sale_id);
      await rpc(sql, "confirm_order_payment", "manual", `M-${uid().slice(0, 10)}`, uid(), 1);
      for (const stmt of [
        sql`UPDATE public.inventory_ledger SET quantity_delta = 99 WHERE product_id = ${product}`,
        sql`DELETE FROM public.inventory_ledger WHERE product_id = ${product}`,
        sql`UPDATE public.pos_tenders SET amount = 1 WHERE sale_id = ${sale.sale_id}`,
        sql`DELETE FROM public.pos_tenders WHERE sale_id = ${sale.sale_id}`,
        sql`UPDATE public.pos_sales SET total = 1, subtotal = 1 WHERE id = ${sale.sale_id}`,
        sql`DELETE FROM public.pos_sales WHERE id = ${sale.sale_id}`,
        sql`UPDATE public.pos_sale_items SET unit_price_rand = 1, line_total = 1 WHERE sale_id = ${sale.sale_id}`,
        sql`UPDATE public.loyalty_ledger SET points = 999 WHERE user_id = ${customer}`,
        sql`DELETE FROM public.payment_events`,
      ]) {
        expect((await attempt(stmt)).ok).toBe(false);
      }
    });

    it("rejects a sale row whose tenders or stock do not reconcile at commit (deferred constraint)", async () => {
      const { sessionId } = await fresh(50, 1);
      const r = await attempt(
        sql.begin(async (tx) => {
          await tx`INSERT INTO public.pos_sales (receipt_number, session_id, cashier_id, subtotal, total, idempotency_key)
                 VALUES (${"RX-" + uid()}, ${sessionId}, ${cashier}, 10, 10, ${key("raw")})`;
        }),
      );
      expect(r.ok).toBe(false);
    });

    it("keeps reservations append-only and forward-only", async () => {
      const product = await mkProduct(sql, 10);
      await receive(sql, manager, product, 2);
      const customer = await mkUser(sql, "customer");
      const o = await rpc(
        sql,
        "create_online_order",
        customer,
        [{ product_id: product, quantity: 1 }],
        "C",
        "0820000000",
        null,
        key("ord"),
        30,
      );
      expect(
        (await attempt(sql`DELETE FROM public.stock_reservations WHERE order_id = ${o.order_id}`))
          .ok,
      ).toBe(false);
      expect(
        (
          await attempt(
            sql`UPDATE public.stock_reservations SET quantity = 2 WHERE order_id = ${o.order_id}`,
          )
        ).ok,
      ).toBe(false);
    });
  });

  describe("authorisation", () => {
    it("customers cannot sell or open tills; a different cashier cannot ring on someone else's till", async () => {
      const { product, sessionId } = await fresh(50, 3);
      const customer = await mkUser(sql, "customer");
      expect(
        failedWith(
          await attempt(sell(sql, customer, sessionId, oneOf(product), [cash("50")])),
          "forbidden",
        ),
      ).toBe(true);
      const otherCashier = await mkUser(sql, "budtender");
      expect(
        failedWith(
          await attempt(sell(sql, otherCashier, sessionId, oneOf(product), [cash("50")])),
          "session_not_yours",
        ),
      ).toBe(true);
      expect((await attempt(sell(sql, manager, sessionId, oneOf(product), [cash("50")]))).ok).toBe(
        true,
      );
    });

    it("the mutating RPCs are not executable by anon or authenticated (only service_role)", async () => {
      for (const role of ["anon", "authenticated"]) {
        const r = await attempt(
          sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL ROLE ${role}`);
            await tx`SELECT public.pos_complete_sale(${uid()}, ${uid()}, '[]'::jsonb, '[]'::jsonb, NULL, 'abcdefgh')`;
          }),
        );
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.message).toMatch(/permission denied/);
      }
    });

    it("refuses to run under REPEATABLE READ (snapshot isolation would defeat the locking design)", async () => {
      const { product, sessionId } = await fresh(50, 1);
      const r = await attempt(
        sql.begin("isolation level repeatable read", async (tx) => {
          await tx`SELECT 1`;
          await tx`SELECT public.pos_complete_sale(${cashier}, ${sessionId}, ${tx.json([{ product_id: product, quantity: 1 }])}, ${tx.json([cash("50")])}, NULL, ${key("rr")})`;
        }),
      );
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.message).toMatch(/^isolation_level/);
    });
  });
});
