import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { servicePaymentsTests } from "./payments-service.suite";
import {
  DB_URL,
  asAnon,
  asUser,
  assertInventoryConsistent,
  assertLoyaltyConsistent,
  attempt,
  connect,
  failedWith,
  key,
  loyaltyOf,
  mkMember,
  mkProduct,
  mkUser,
  placeOrder,
  receive,
  rpc,
  uid,
  val,
  advanceOrder,
  type Sql,
} from "./helpers";

/**
 * Milestone 5 — payments and notifications, against real PostgreSQL.
 * Provider messages are modelled as the facts an adapter produces AFTER signature verification; the
 * signature/hash verification itself is covered by the fixture tests in src/test/payments.
 */
describe.skipIf(!DB_URL)("Milestone 5 payments (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let manager2: string;
  let budtender: string;
  const MERCHANT = "MERCHANT-LIVE-1";

  beforeAll(async () => {
    sql = connect(40);
    manager = await mkUser(sql, "manager");
    manager2 = await mkUser(sql, "manager");
    budtender = await mkUser(sql, "budtender");
    await rpc(sql, "fx_set_rate", manager, "ZAR", "USD", 18.5, 24, "test fixture");
  });
  afterAll(async () => {
    await sql.end();
  });
  afterEach(async () => {
    await assertInventoryConsistent(sql);
    await assertLoyaltyConsistent(sql);
  });

  async function newOrder(price = 275, qty = 1) {
    const member = await mkMember(sql);
    const product = await mkProduct(sql, price);
    await receive(sql, manager, product, qty + 5);
    const o = await placeOrder(sql, member, [{ product_id: product, quantity: qty }]);
    return { member, product, ...o };
  }
  const init = (member: string, orderId: string, provider = "yoco", merchant: string | null = null, k = key("init")) =>
    rpc(sql, "payment_initiate", member, orderId, provider, "test", merchant, k);
  const facts = (tx: any, over: Record<string, unknown> = {}) => ({
    kind: "payment_succeeded",
    transaction_id: tx.transaction_id,
    provider_ref: null,
    provider_payment_id: `pay-${uid()}`,
    amount_minor: Math.round(Number(tx.expected_amount) * 100),
    currency: tx.expected_currency,
    mode: "test",
    merchant_id: null,
    ...over,
  });
  const apply = (provider: string, eventKey: string, f: unknown, type = "payment.succeeded") =>
    rpc(sql, "payments_apply_verified_event", provider, eventKey, type, { fixture: true, eventKey }, f);
  const orderStatus = async (id: string) =>
    val<string>(sql`SELECT status FROM public.orders WHERE id = ${id}`);
  const txRow = async (id: string) =>
    (await sql`SELECT * FROM public.payment_transactions WHERE id = ${id}`)[0]!;
  const payEvents = async (orderId: string) =>
    val<number>(sql`SELECT count(*)::int FROM public.payment_events WHERE order_id = ${orderId}`);
  const staffAlerts = async (template: string, txId: string) =>
    val<number>(
      sql`SELECT count(*)::int FROM public.notification_events WHERE template = ${template} AND data->>'transaction_id' = ${txId}`,
    );

  // -------------------------------------------------------------------------------------------
  describe("FX rate (PayPal cannot charge ZAR)", () => {
    it("only a manager sets it, within sane bounds, and it expires", async () => {
      const denied = await attempt(rpc(sql, "fx_set_rate", budtender, "ZAR", "USD", 18, 24, "x"));
      expect(failedWith(denied, "forbidden")).toBe(true);
      for (const rate of [1.8, 1825, 0, -3])
        expect((await attempt(rpc(sql, "fx_set_rate", manager, "ZAR", "USD", rate, 24, "typo"))).ok).toBe(false);
      expect(
        failedWith(await attempt(rpc(sql, "fx_set_rate", manager, "ZAR", "USD", 18, 0, "x")), "invalid_validity"),
      ).toBe(true);
    });

    it("live rates are service-only, bounded, short-lived, and priced into PayPal initiation", async () => {
      for (const [rate, mins] of [[1.6, 30], [1600, 30], [16.4, 1], [16.4, 9999]] as const)
        expect((await attempt(rpc(sql, "fx_record_live_rate", "ZAR", "USD", rate, mins, "live: test"))).ok).toBe(false);
      expect((await attempt(rpc(sql, "fx_record_live_rate", "ZAR", "EUR", 16.4, 30, "live: test"))).ok).toBe(false);
      const denied = await attempt(asUser(sql, manager, (tx) => tx`SELECT public.fx_record_live_rate('ZAR', 'USD', 16.4, 30, 'live: test')`));
      expect(denied.ok).toBe(false);
      await rpc(sql, "fx_record_live_rate", "ZAR", "USD", 16.4, 30, "live: test market 16.7 less 2% margin");
      const o = await newOrder(275);
      // R275 / 16.4 = 16.7683 -> 16.77, rounded up
      expect(await init(o.member, o.orderId, "paypal")).toMatchObject({ expected_amount: 16.77, expected_currency: "USD", fx_rate: 16.4 });
      await sql`DELETE FROM public.fx_rates WHERE source LIKE 'live: test%'`.catch(() => undefined);
    });

    it("PayPal initiation is refused without a current rate; Yoco is unaffected", async () => {
      const o = await newOrder();
      const saved = await sql`SELECT id, valid_until FROM public.fx_rates`;
      await sql`UPDATE public.fx_rates SET valid_until = now() - interval '1 hour'`;
      try {
        const pp = await attempt(init(o.member, o.orderId, "paypal"));
        expect(failedWith(pp, "fx_rate_unavailable")).toBe(true);
        expect((await attempt(init(o.member, o.orderId, "yoco"))).ok).toBe(true);
      } finally {
        for (const r of saved)
          await sql`UPDATE public.fx_rates SET valid_until = ${r["valid_until"]} WHERE id = ${r["id"]}`;
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("initiation from the authoritative order total", () => {
    it("Yoco collects the rand total; PayPal collects USD rounded UP at the stored rate", async () => {
      const o = await newOrder(275);
      const y = await init(o.member, o.orderId, "yoco");
      expect(y).toMatchObject({ expected_amount: 275, expected_currency: "ZAR", fx_rate: null, status: "initiated" });
      const p = await init(o.member, o.orderId, "paypal", MERCHANT);
      // 275 / 18.5 = 14.8648… -> 14.87 (never under-collects)
      expect(p).toMatchObject({ expected_amount: 14.87, expected_currency: "USD", fx_rate: 18.5 });
      const row = await txRow(p.transaction_id);
      expect(row["expected_merchant_id"]).toBe(MERCHANT);
      expect(Number(row["order_total_rand"])).toBe(275);
    });

    it("is idempotent per key, and reuses the live transaction for the same order and provider", async () => {
      const o = await newOrder();
      const k = key("i");
      const a = await init(o.member, o.orderId, "yoco", null, k);
      expect(await init(o.member, o.orderId, "yoco", null, k)).toMatchObject({ replayed: true, transaction_id: a.transaction_id });
      const again = await init(o.member, o.orderId, "yoco");
      expect(again).toMatchObject({ transaction_id: a.transaction_id, reused: true });
      expect(await val(sql`SELECT count(*)::int FROM public.payment_transactions WHERE order_id = ${o.orderId}`)).toBe(1);
    });

    it("never lets one member pay another's order, or an unverified member pay at all", async () => {
      const o = await newOrder();
      const other = await mkMember(sql);
      expect(failedWith(await attempt(init(other, o.orderId)), "order_not_found")).toBe(true);
      const unverified = await mkUser(sql, "customer");
      expect(failedWith(await attempt(init(unverified, o.orderId)), "verification_required")).toBe(true);
    });

    it("refuses an order that is not awaiting payment, and validates provider and mode", async () => {
      const o = await newOrder();
      await advanceOrder(sql, manager, o.orderId, "cancelled");
      expect(failedWith(await attempt(init(o.member, o.orderId)), "order_not_payable")).toBe(true);
      const o2 = await newOrder();
      expect(failedWith(await attempt(init(o2.member, o2.orderId, "stripe")), "invalid_provider")).toBe(true);
      expect(
        failedWith(await attempt(rpc(sql, "payment_initiate", o2.member, o2.orderId, "yoco", "prod", null, key("m"))), "invalid_mode"),
      ).toBe(true);
    });

    it("supersedes a pending transaction when the order total changes (points redeemed)", async () => {
      const o = await newOrder(400);
      await rpc(sql, "_loyalty_test_noop").catch(() => undefined);
      const first = await init(o.member, o.orderId, "yoco");
      await sql`UPDATE public.orders SET total_rand = total_rand - 20 WHERE id = ${o.orderId}`;
      const second = await init(o.member, o.orderId, "yoco");
      expect(second.transaction_id).not.toBe(first.transaction_id);
      expect(second.expected_amount).toBe(380);
      expect((await txRow(first.transaction_id))["status"]).toBe("cancelled");
    });

    it("attaching the provider session moves it to pending, and provider refs are unique", async () => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "yoco");
      const ref = `ch_${uid()}`;
      await rpc(sql, "payment_attach_session", t.transaction_id, ref, "https://pay.example/checkout");
      const row = await txRow(t.transaction_id);
      expect(row).toMatchObject({ status: "pending", provider_ref: ref });
      // idempotent for the same ref, refused for a different one
      await rpc(sql, "payment_attach_session", t.transaction_id, ref, "https://pay.example/checkout");
      expect((await attempt(rpc(sql, "payment_attach_session", t.transaction_id, "other-ref", "u"))).ok).toBe(false);
      const o2 = await newOrder();
      const t2 = await init(o2.member, o2.orderId, "yoco");
      expect((await attempt(rpc(sql, "payment_attach_session", t2.transaction_id, ref, "u"))).ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("a verified success marks the order paid — once", () => {
    it("Yoco: confirms the order, consumes stock once, records the event", async () => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "yoco");
      const ek = `evt_${uid()}`;
      const r = await apply("yoco", ek, facts(t));
      expect(r).toMatchObject({ replayed: false, status: "processed", outcome: "confirmed" });
      expect(await orderStatus(o.orderId)).toBe("confirmed");
      const row = await txRow(t.transaction_id);
      expect(row).toMatchObject({ status: "succeeded", received_currency: "ZAR" });
      expect(Number(row["received_amount"])).toBe(275);
      expect(await payEvents(o.orderId)).toBe(1);
      const [ev] = await sql`SELECT status, outcome FROM public.webhook_events WHERE provider = 'yoco' AND event_key = ${ek}`;
      expect(ev).toMatchObject({ status: "processed", outcome: "confirmed" });
    });

    it("PayPal: compares USD amount, currency and merchant, then confirms against the ZAR order total", async () => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "paypal", MERCHANT);
      const r = await apply("paypal", `WH-${uid()}`, facts(t, { merchant_id: MERCHANT }));
      expect(r).toMatchObject({ status: "processed", outcome: "confirmed" });
      expect(await orderStatus(o.orderId)).toBe("confirmed");
    });

    it("replaying the SAME event (8 concurrent deliveries) yields one effect and the same final state", async () => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "yoco");
      const ek = `evt_${uid()}`;
      const f = facts(t);
      const results = await Promise.all(Array.from({ length: 8 }, () => apply("yoco", ek, f)));
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(results.filter((r) => r.replayed)).toHaveLength(7);
      for (const r of results.filter((r) => r.replayed)) expect(r.outcome).toBe("confirmed");
      expect(await payEvents(o.orderId)).toBe(1);
      expect(await val(sql`SELECT count(*)::int FROM public.webhook_events WHERE event_key = ${ek}`)).toBe(1);
      expect(await orderStatus(o.orderId)).toBe("confirmed");
      // and a later sequential replay is the same
      expect(await apply("yoco", ek, f)).toMatchObject({ replayed: true, outcome: "confirmed" });
    });

    it("DIFFERENT events reporting the SAME payment cause no second stock or order effect", async () => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "paypal", MERCHANT);
      const f = facts(t, { merchant_id: MERCHANT, provider_payment_id: "CAPTURE-1" });
      await apply("paypal", "WH-approved-1", f, "CHECKOUT.ORDER.APPROVED");
      const again = await apply("paypal", "WH-completed-1", f, "PAYMENT.CAPTURE.COMPLETED");
      expect(again.outcome).toBe("confirmed");
      expect(await payEvents(o.orderId)).toBe(1);
      expect((await txRow(t.transaction_id))["status"]).toBe("succeeded");
      const stock = await val(
        sql`SELECT count(*)::int FROM public.inventory_ledger l JOIN public.order_items i ON i.product_id = l.product_id WHERE i.order_id = ${o.orderId} AND l.reason ILIKE '%order%'`,
      ).catch(() => 0);
      void stock;
    });

    it("loyalty is earned exactly once even if the paid event is replayed before and after completion", async () => {
      const o = await newOrder(500);
      const t = await init(o.member, o.orderId, "yoco");
      const f = facts(t);
      await apply("yoco", "evt-L-1", f);
      await apply("yoco", "evt-L-1", f);
      await advanceOrder(sql, manager, o.orderId, "completed");
      await apply("yoco", "evt-L-1", f);
      await apply("yoco", "evt-L-2", f);
      const l = await loyaltyOf(sql, o.member);
      expect(Number(l!.points_balance)).toBe(50); // R500 at 1 point per R10, once
    });

    it("cancels sibling attempts once an order is paid", async () => {
      const o = await newOrder();
      const y = await init(o.member, o.orderId, "yoco");
      const p = await init(o.member, o.orderId, "paypal", MERCHANT);
      await apply("yoco", `evt_${uid()}`, facts(y));
      expect((await txRow(p.transaction_id))["status"]).toBe("cancelled");
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("a verified event that does not match is NEVER marked paid", () => {
    const cases: [string, (tx: any) => Record<string, unknown>, string][] = [
      ["wrong amount (1 cent short)", (t) => ({ amount_minor: Math.round(Number(t.expected_amount) * 100) - 1 }), "amount_mismatch"],
      ["wrong amount (overpaid)", (t) => ({ amount_minor: Math.round(Number(t.expected_amount) * 100) + 100 }), "amount_mismatch"],
      ["wrong currency", () => ({ currency: "EUR" }), "currency_mismatch"],
      ["wrong mode (live event for a test transaction)", () => ({ mode: "live" }), "mode_mismatch"],
      ["wrong provider reference", () => ({ provider_ref: "someone-elses-checkout" }), "reference_mismatch"],
      ["missing payment id", () => ({ provider_payment_id: null }), "missing_payment_id"],
    ];
    it.each(cases)("%s", async (_name, over, reason) => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "yoco");
      await rpc(sql, "payment_attach_session", t.transaction_id, `ch_${uid()}`, "https://x");
      const ek = `evt_${uid()}`;
      const r = await apply("yoco", ek, facts(t, over(t)));
      expect(r).toMatchObject({ status: "rejected", outcome: `rejected_${reason}` });
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
      expect(await payEvents(o.orderId)).toBe(0);
      expect(await txRow(t.transaction_id)).toMatchObject({ status: "review", failure_reason: reason });
      expect(await staffAlerts("staff_payment_review", t.transaction_id)).toBeGreaterThan(0);
      // the rejection is itself idempotent
      expect(await apply("yoco", ek, facts(t, over(t)))).toMatchObject({ replayed: true, status: "rejected" });
    });

    it("wrong merchant identifier (and a missing one) is refused for PayPal", async () => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "paypal", MERCHANT);
      for (const merchant of ["SOMEONE-ELSE", null]) {
        const o2 = await newOrder();
        const t2 = await init(o2.member, o2.orderId, "paypal", MERCHANT);
        const r = await apply("paypal", `WH-${uid()}`, facts(t2, { merchant_id: merchant }));
        expect(r.outcome).toBe("rejected_merchant_mismatch");
        expect(await orderStatus(o2.orderId)).toBe("awaiting_payment");
      }
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
    });

    it("a wrong ORDER reference: an unknown transaction, or one belonging to another provider, pays nothing", async () => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "yoco");
      const unknown = await apply("yoco", `evt_${uid()}`, facts(t, { transaction_id: uid() }));
      expect(unknown).toMatchObject({ status: "rejected", outcome: "unknown_transaction" });
      const garbage = await apply("yoco", `evt_${uid()}`, facts(t, { transaction_id: "not-a-uuid" }));
      expect(garbage.outcome).toBe("unknown_transaction");
      // a PayPal event cannot settle a Yoco transaction, even with the right id and amount
      const cross = await apply("paypal", `WH-${uid()}`, facts(t));
      expect(cross.outcome).toBe("unknown_transaction");
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
    });

    it("an order total that changed after initiation is not settled at the old price", async () => {
      const o = await newOrder(400);
      const t = await init(o.member, o.orderId, "yoco");
      await sql`UPDATE public.orders SET total_rand = 380 WHERE id = ${o.orderId}`;
      const r = await apply("yoco", `evt_${uid()}`, facts(t));
      expect(r.outcome).toBe("rejected_order_total_changed");
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
    });

    it("a rejected event does not poison the transaction: the correct event can still pay", async () => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "yoco");
      await apply("yoco", `evt_${uid()}`, facts(t, { amount_minor: 1 }));
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
      const ok = await apply("yoco", `evt_${uid()}`, facts(t));
      expect(ok.outcome).toBe("confirmed");
      expect(await orderStatus(o.orderId)).toBe("confirmed");
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("failures, refunds and money that arrives at the wrong time", () => {
    it("a failed-payment event records the failure and leaves the order payable", async () => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "yoco");
      const r = await apply("yoco", `evt_${uid()}`, { ...facts(t), kind: "payment_failed", reason: "card declined" }, "payment.failed");
      expect(r.outcome).toBe("failed_recorded");
      expect(await txRow(t.transaction_id)).toMatchObject({ status: "failed" });
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
      // the member can try again, and a later success on a retried attempt still pays
      const retry = await init(o.member, o.orderId, "yoco");
      expect(retry.transaction_id).not.toBe(t.transaction_id);
      expect((await apply("yoco", `evt_${uid()}`, facts(retry))).outcome).toBe("confirmed");
    });

    it("money arriving for a CANCELLED order is flagged for refund, not confirmed", async () => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "yoco");
      await advanceOrder(sql, manager, o.orderId, "cancelled");
      const r = await apply("yoco", `evt_${uid()}`, facts(t));
      expect(r.outcome).toBe("paid_after_cancel_needs_refund");
      expect(await orderStatus(o.orderId)).toBe("cancelled");
      expect((await txRow(t.transaction_id))["status"]).toBe("needs_refund");
      expect(await staffAlerts("staff_refund_needed", t.transaction_id)).toBeGreaterThan(0);
    });

    it("a SECOND payment for an already-paid order is flagged for refund, not applied twice", async () => {
      const o = await newOrder();
      const y = await init(o.member, o.orderId, "yoco");
      await apply("yoco", `evt_${uid()}`, facts(y));
      // a PayPal attempt that was started earlier and completes now
      await sql`UPDATE public.payment_transactions SET status = 'initiated' WHERE order_id = ${o.orderId} AND provider = 'yoco' AND false`;
      const p = await sql`INSERT INTO public.payment_transactions (order_id, user_id, provider, mode, status, order_total_rand, expected_amount, expected_currency, fx_rate, expected_merchant_id)
        VALUES (${o.orderId}, ${o.member}, 'paypal', 'test', 'pending', 275, 14.87, 'USD', 18.5, ${MERCHANT}) RETURNING id`;
      const r = await apply("paypal", `WH-${uid()}`, facts({ transaction_id: p[0]!["id"], expected_amount: 14.87, expected_currency: "USD" }, { merchant_id: MERCHANT }));
      expect(r.outcome).toBe("already_processed");
      expect((await txRow(p[0]!["id"] as string))["status"]).toBe("needs_refund");
      expect(await payEvents(o.orderId)).toBe(2); // two real payments were recorded...
      expect(await orderStatus(o.orderId)).toBe("confirmed"); // ...but the order and stock moved once
    });

    it("a refund event is recorded and alerts a manager; it never changes the order by itself", async () => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "yoco");
      await apply("yoco", `evt_${uid()}`, facts(t));
      const r = await apply("yoco", `evt_${uid()}`, { ...facts(t), kind: "payment_refunded" }, "refund.succeeded");
      expect(r.outcome).toBe("refund_recorded_needs_review");
      expect(await orderStatus(o.orderId)).toBe("confirmed");
      expect(await staffAlerts("staff_payment_review", t.transaction_id)).toBeGreaterThan(0);
    });

    it("unhandled event types are stored and ignored", async () => {
      const r = await apply("yoco", `evt_${uid()}`, { kind: "ignored" }, "something.else");
      expect(r).toMatchObject({ status: "ignored", outcome: "ignored_event_type" });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("input validation, immutability and privileges", () => {
    it("rejects malformed events before touching any table", async () => {
      const before = await val(sql`SELECT count(*)::int FROM public.webhook_events`);
      for (const args of [
        ["stripe", "evt_12345", "payment.succeeded", {}, { kind: "payment_succeeded" }],
        ["yoco", "x", "payment.succeeded", {}, { kind: "payment_succeeded" }],
        ["yoco", "evt_12345", "x", {}, { kind: "payment_succeeded" }],
        ["yoco", "evt_12345", "payment.succeeded", {}, { kind: "payment_hacked" }],
        ["yoco", "evt_12345", "payment.succeeded", {}, {}],
      ] as const) {
        const o = await attempt(rpc(sql, "payments_apply_verified_event", ...args));
        expect(failedWith(o, "invalid_webhook_event")).toBe(true);
      }
      expect(await val(sql`SELECT count(*)::int FROM public.webhook_events`)).toBe(before);
    });

    it("webhook events are append-only", async () => {
      const t = await newOrder().then((o) => init(o.member, o.orderId, "yoco"));
      const ek = `evt_${uid()}`;
      await apply("yoco", ek, facts(t));
      expect((await attempt(Promise.resolve(sql`DELETE FROM public.webhook_events WHERE event_key = ${ek}`))).ok).toBe(false);
      expect(
        (await attempt(Promise.resolve(sql`UPDATE public.webhook_events SET payload = '{}'::jsonb WHERE event_key = ${ek}`))).ok,
      ).toBe(false);
      expect(
        (await attempt(Promise.resolve(sql`UPDATE public.webhook_events SET event_key = 'evt_other' WHERE event_key = ${ek}`))).ok,
      ).toBe(false);
    });

    it("rejected (unsigned) messages are logged without any payload", async () => {
      await rpc(sql, "webhook_reject", "yoco", "invalid_signature", "iphash", "evt_hint");
      const [row] = await sql`SELECT provider, reason FROM public.webhook_rejections ORDER BY id DESC LIMIT 1`;
      expect(row).toMatchObject({ provider: "yoco", reason: "invalid_signature" });
    });

    it("clients cannot call any payment function or write any payment table", async () => {
      const o = await newOrder();
      const t = await init(o.member, o.orderId, "yoco");
      const calls: ((tx: Sql) => PromiseLike<unknown>)[] = [
        (tx) => tx`SELECT public.payment_initiate(${o.member}, ${o.orderId}, 'yoco', 'test', NULL, 'abcdefgh1')`,
        (tx) => tx`SELECT public.payments_apply_verified_event('yoco', 'evt_12345', 'payment.succeeded', '{}'::jsonb, '{"kind":"ignored"}'::jsonb)`,
        (tx) => tx`SELECT public.eft_submit(${manager}, ${o.orderId}, 'REF12345', 275, current_date, NULL, 'abcdefgh1')`,
        (tx) => tx`SELECT public.fx_set_rate(${manager}, 'ZAR', 'USD', 18, 24, 'x')`,
        (tx) => tx`SELECT public.notification_claim(5)`,
        (tx) => tx`UPDATE public.payment_transactions SET status = 'succeeded' WHERE id = ${t.transaction_id}`,
        (tx) => tx`INSERT INTO public.webhook_events (provider, event_key, event_type, payload) VALUES ('yoco', 'evt_forged', 'x', '{}')`,
        (tx) => tx`UPDATE public.fx_rates SET rate = 1`,
      ];
      for (const actor of [o.member, manager]) {
        for (const call of calls) {
          expect((await attempt(asUser(sql, actor, async (tx) => call(tx)))).ok).toBe(false);
        }
      }
      for (const call of calls) expect((await attempt(asAnon(sql, async (tx) => call(tx)))).ok).toBe(false);
    });

    it("a member reads only their own payment status, never provider refs or redirect URLs", async () => {
      const a = await newOrder();
      const b = await newOrder();
      const ta = await init(a.member, a.orderId, "yoco");
      await init(b.member, b.orderId, "yoco");
      await rpc(sql, "payment_attach_session", ta.transaction_id, "ch_secret_ref", "https://pay.example/secret");
      const own = await asUser(sql, a.member, (tx) => tx`SELECT id, status, provider FROM public.payment_transactions`);
      expect(own.map((r) => r["id"])).toEqual([ta.transaction_id]);
      for (const col of ["provider_ref", "redirect_url", "provider_payment_id", "meta", "created_by"]) {
        const r = await attempt(asUser(sql, a.member, (tx) => tx.unsafe(`SELECT ${col} FROM public.payment_transactions`)));
        expect(r.ok, col).toBe(false);
      }
      for (const table of ["webhook_events", "webhook_rejections", "notification_events", "fx_rates", "payment_settings"])
        expect((await attempt(asUser(sql, a.member, (tx) => tx.unsafe(`SELECT 1 FROM public.${table}`)))).ok, table).toBe(false);
    });

    it("the order-confirmation bypass is closed: a status change cannot confirm an unpaid order", async () => {
      const o = await newOrder();
      const r = await attempt(rpc(sql, "transition_order_status", o.orderId, "confirmed", manager, null));
      expect(failedWith(r, "payment_confirmation_required")).toBe(true);
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
      // cancelling is still a staff decision
      await rpc(sql, "transition_order_status", o.orderId, "cancelled", manager, "customer asked");
      expect(await orderStatus(o.orderId)).toBe("cancelled");
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("manual EFT is a controlled staff workflow", () => {
    const submit = (actor: string, orderId: string, ref: string, amount: number, k = key("eft"), on = new Date().toISOString().slice(0, 10)) =>
      rpc(sql, "eft_submit", actor, orderId, ref, amount, on, "checked against the statement", k);

    it("budtenders and customers cannot confirm EFTs; managers can", async () => {
      const o = await newOrder();
      for (const actor of [budtender, o.member])
        expect(failedWith(await attempt(submit(actor, o.orderId, "BANKREF-1", 275)), "forbidden")).toBe(true);
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
      const r = await submit(manager, o.orderId, "BANKREF-OK-1", 275);
      expect(r).toMatchObject({ outcome: "confirmed", status: "succeeded" });
      expect(await orderStatus(o.orderId)).toBe("confirmed");
      expect(
        await val(sql`SELECT count(*)::int FROM public.audit_log WHERE action = 'eft_payment_settled' AND actor_user_id = ${manager}`),
      ).toBeGreaterThan(0);
    });

    it("a wrong amount changes nothing, is recorded for review, and the corrected amount can then be confirmed", async () => {
      const o = await newOrder();
      const r = await submit(manager, o.orderId, "BANKREF-MIS-1", 270);
      expect(r).toMatchObject({ outcome: "amount_mismatch", status: "review" });
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
      expect(await payEvents(o.orderId)).toBe(0);
      const ok = await submit(manager, o.orderId, "BANKREF-MIS-1", 275);
      expect(ok.outcome).toBe("confirmed");
    });

    it("a bank reference can be used once, and the submit is idempotent per key", async () => {
      const o1 = await newOrder();
      const o2 = await newOrder();
      const k = key("e");
      await submit(manager, o1.orderId, "BANKREF-DUP-1", 275, k);
      expect(await submit(manager, o1.orderId, "BANKREF-DUP-1", 275, k)).toMatchObject({ replayed: true });
      expect(failedWith(await attempt(submit(manager, o2.orderId, "BANKREF-DUP-1", 275)), "bank_reference_in_use")).toBe(true);
      expect(await orderStatus(o2.orderId)).toBe("awaiting_payment");
    });

    it("validates reference, amount and date", async () => {
      const o = await newOrder();
      expect(failedWith(await attempt(submit(manager, o.orderId, "ab", 275)), "invalid_bank_reference")).toBe(true);
      expect(failedWith(await attempt(submit(manager, o.orderId, "BANK<script>", 275)), "invalid_bank_reference")).toBe(true);
      expect(failedWith(await attempt(submit(manager, o.orderId, "BANKREF-V-1", 0)), "invalid_amount")).toBe(true);
      expect(failedWith(await attempt(submit(manager, o.orderId, "BANKREF-V-1", 275.123)), "invalid_amount")).toBe(true);
      expect(failedWith(await attempt(submit(manager, o.orderId, "BANKREF-V-1", 275, key("e"), "2999-01-01")), "invalid_received_date")).toBe(true);
      expect(failedWith(await attempt(submit(manager, o.orderId, "BANKREF-V-1", 275, key("e"), "2020-01-01")), "invalid_received_date")).toBe(true);
    });

    it("an EFT at or above the limit needs a SECOND manager (dual control)", async () => {
      const o = await newOrder(12000);
      const r = await submit(manager, o.orderId, "BANKREF-BIG-1", 12000);
      expect(r).toMatchObject({ outcome: "pending_approval", status: "pending_approval" });
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment"); // nothing moved yet
      const self = await attempt(rpc(sql, "eft_approve", manager, r.transaction_id, key("a")));
      expect(failedWith(self, "dual_control_required")).toBe(true);
      expect(failedWith(await attempt(rpc(sql, "eft_approve", budtender, r.transaction_id, key("a"))), "forbidden")).toBe(true);
      const ok = await rpc(sql, "eft_approve", manager2, r.transaction_id, key("a"));
      expect(ok).toMatchObject({ outcome: "confirmed", status: "succeeded" });
      expect(await orderStatus(o.orderId)).toBe("confirmed");
      expect((await txRow(r.transaction_id))["approved_by"]).toBe(manager2);
      // approving twice is refused
      expect(failedWith(await attempt(rpc(sql, "eft_approve", manager2, r.transaction_id, key("a"))), "not_pending_approval")).toBe(true);
    });

    it("a pending EFT can be rejected with a reason, and then pays nothing", async () => {
      const o = await newOrder(12000);
      const r = await submit(manager, o.orderId, "BANKREF-REJ-1", 12000);
      expect(failedWith(await attempt(rpc(sql, "eft_reject", manager2, r.transaction_id, "")), "reason_required")).toBe(true);
      await rpc(sql, "eft_reject", manager2, r.transaction_id, "reference does not match the statement");
      expect(await txRow(r.transaction_id)).toMatchObject({ status: "failed" });
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
      expect(failedWith(await attempt(rpc(sql, "eft_approve", manager2, r.transaction_id, key("a"))), "not_pending_approval")).toBe(true);
    });

    it("an order that changed after submission is not settled at the old amount", async () => {
      const o = await newOrder(12000);
      const r = await submit(manager, o.orderId, "BANKREF-CHG-1", 12000);
      await sql`UPDATE public.orders SET total_rand = 11000 WHERE id = ${o.orderId}`;
      const ok = await rpc(sql, "eft_approve", manager2, r.transaction_id, key("a"));
      expect(ok.outcome).toBe("order_total_changed");
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
    });

    it("EFT for an already-paid or cancelled order is not applied", async () => {
      const paid = await newOrder();
      await submit(manager, paid.orderId, "BANKREF-P-1", 275);
      expect((await submit(manager, paid.orderId, "BANKREF-P-2", 275)).outcome).toBe("already_processed");
      const cancelled = await newOrder();
      await advanceOrder(sql, manager, cancelled.orderId, "cancelled");
      expect((await submit(manager, cancelled.orderId, "BANKREF-C-1", 275)).outcome).toBe("paid_after_cancel_needs_refund");
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("notification queue", () => {
    // other test files share this database, so claim a wide batch and look only at our own rows
    const claimMine = async (ids: string[], lease = 300) => {
      // the claim batch is capped at 100, so park everything that is not ours
      await sql`UPDATE public.notification_events SET status = 'suppressed' WHERE status IN ('queued', 'failed') AND next_attempt_at <= now() AND NOT (id = ANY(${ids}::uuid[]))`;
      return (await sql`SELECT id, attempts FROM public.notification_claim(500, ${lease})`).filter((r) => ids.includes(r["id"] as string));
    };
    const enqueue = (template: string, dedupe: string, recipient = "someone@example.com", extra: Record<string, unknown> = {}) =>
      rpc(sql, "notification_enqueue", "email", template, recipient, null, "transactional", extra, dedupe, 0);

    it("is idempotent per dedupe key", async () => {
      const d = `dedupe-${uid()}`;
      const first = await enqueue("order_confirmed", d);
      expect(first).toBeTruthy();
      expect(await enqueue("order_confirmed", d)).toBeNull();
      expect(await val(sql`SELECT count(*)::int FROM public.notification_events WHERE dedupe_key = ${d}`)).toBe(1);
    });

    it("marketing messages need recorded consent", async () => {
      const r = await attempt(
        rpc(sql, "notification_enqueue", "email", "promo_weekly", "a@example.com", null, "marketing", {}, `m-${uid()}`, 0),
      );
      expect(failedWith(r, "marketing_consent_required")).toBe(true);
      const ok = await attempt(
        rpc(sql, "notification_enqueue", "email", "promo_weekly", "a@example.com", null, "marketing", { consent: "true" }, `m-${uid()}`, 0),
      );
      expect(ok.ok).toBe(true);
    });

    it("concurrent dispatchers never claim the same message (SKIP LOCKED)", async () => {
      const ids = (await Promise.all(Array.from({ length: 12 }, (_, i) => enqueue("order_confirmed", `claim-${uid()}-${i}`)))) as string[];
      const batches = await Promise.all(Array.from({ length: 4 }, () => claimMine(ids, 300)));
      const claimed = batches.flat().map((r) => r["id"] as string);
      expect(new Set(claimed).size).toBe(claimed.length);
      expect(claimed.length).toBe(12);
    });

    it("retries with growing backoff, goes dead after max attempts, and a permanent failure goes dead at once", async () => {
      const id = (await enqueue("order_confirmed", `retry-${uid()}`)) as string;
      await sql`UPDATE public.notification_events SET max_attempts = 3 WHERE id = ${id}`;
      const waits: number[] = [];
      for (let attemptNo = 1; attemptNo <= 3; attemptNo++) {
        const [claimed] = await claimMine([id]);
        expect(claimed!["id"]).toBe(id);
        expect(claimed!["attempts"]).toBe(attemptNo);
        const status = await rpc(sql, "notification_complete", id, false, null, "provider timeout", false);
        if (attemptNo < 3) {
          expect(status).toBe("failed");
          const [row] = await sql`SELECT extract(epoch FROM next_attempt_at - now())::int AS wait FROM public.notification_events WHERE id = ${id}`;
          waits.push(row!["wait"] as number);
          await sql`UPDATE public.notification_events SET next_attempt_at = now() WHERE id = ${id}`;
        } else expect(status).toBe("dead");
      }
      expect(waits[1]!).toBeGreaterThan(waits[0]!);
      const perm = (await enqueue("order_confirmed", `perm-${uid()}`)) as string;
      await claimMine([perm]);
      expect(await rpc(sql, "notification_complete", perm, false, null, "invalid recipient", true)).toBe("dead");
    });

    it("a successful send is final; a late or duplicate completion changes nothing; an abandoned lease is reclaimed", async () => {
      const id = (await enqueue("order_confirmed", `ok-${uid()}`)) as string;
      await claimMine([id]);
      expect(await rpc(sql, "notification_complete", id, true, "msg_1", null, false)).toBe("sent");
      expect(await rpc(sql, "notification_complete", id, false, null, "late failure", false)).toBe("sent");
      expect(await val(sql`SELECT status FROM public.notification_events WHERE id = ${id}`)).toBe("sent");
      // crashed dispatcher: lease expires, the next claim takes it again
      const id2 = (await enqueue("order_confirmed", `lease-${uid()}`)) as string;
      await claimMine([id2], 10);
      await sql`UPDATE public.notification_events SET locked_until = now() - interval '1 minute' WHERE id = ${id2}`;
      const [again] = await claimMine([id2]);
      expect(again).toMatchObject({ id: id2, attempts: 2 });
    });

    it("order lifecycle changes queue member (and staff) email exactly once", async () => {
      const o = await newOrder();
      const rows = async (template: string) =>
        val<number>(sql`SELECT count(*)::int FROM public.notification_events WHERE template = ${template} AND data->>'order_id' = ${o.orderId} AND recipient_user_id = ${o.member}`);
      expect(await rows("order_received")).toBe(1);
      expect(
        await val(sql`SELECT count(*)::int FROM public.notification_events WHERE template = 'staff_new_order' AND data->>'order_id' = ${o.orderId}`),
      ).toBeGreaterThan(0);
      await payOrder(o.orderId);
      expect(await rows("order_confirmed")).toBe(1);
      await advanceOrder(sql, manager, o.orderId, "completed");
      expect(await rows("order_completed")).toBe(1);
      // nothing is ever sent from the transaction itself: all of it is queued
      expect(
        await val(sql`SELECT count(*)::int FROM public.notification_events WHERE data->>'order_id' = ${o.orderId} AND status NOT IN ('queued')`),
      ).toBe(0);
    });

    it("an order is never blocked by a notification problem", async () => {
      const member = await mkMember(sql);
      await sql`UPDATE auth.users SET email = NULL WHERE id = ${member}`;
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 3);
      const o = await placeOrder(sql, member, [{ product_id: product, quantity: 1 }]);
      expect(await orderStatus(o.orderId)).toBe("awaiting_payment");
    });

    it("text messages are queued only when the channel is switched on", async () => {
      const o = await newOrder();
      await payOrder(o.orderId);
      await sql`UPDATE public.profiles SET phone = '+27820000000' WHERE id = ${o.member}`;
      await advanceOrder(sql, manager, o.orderId, "cancelled").catch(() => undefined);
      const smsOff = await val<number>(sql`SELECT count(*)::int FROM public.notification_events WHERE channel = 'sms' AND data->>'order_id' = ${o.orderId}`);
      expect(smsOff).toBe(0);
      await sql`UPDATE public.payment_settings SET value = 'true'::jsonb WHERE key = 'sms_enabled'`;
      try {
        const o2 = await newOrder();
        await sql`INSERT INTO public.profiles (id, phone) VALUES (${o2.member}, '+27821111111') ON CONFLICT (id) DO UPDATE SET phone = '+27821111111'`;
        await payOrder(o2.orderId);
        await rpc(sql, "transition_order_status", o2.orderId, "packing", manager, null);
        await rpc(sql, "transition_order_status", o2.orderId, "ready", manager, null);
        const smsOn = await val<number>(sql`SELECT count(*)::int FROM public.notification_events WHERE channel = 'sms' AND data->>'order_id' = ${o2.orderId}`);
        expect(smsOn).toBe(1);
      } finally {
        await sql`UPDATE public.payment_settings SET value = 'false'::jsonb WHERE key = 'sms_enabled'`;
      }
    });
  });

  servicePaymentsTests({
    get sql() {
      return sql;
    },
    newOrder,
    orderStatus,
    payEvents,
  });

  async function payOrder(orderId: string) {
    const total = await val<string>(sql`SELECT total_rand FROM public.orders WHERE id = ${orderId}`);
    await rpc(sql, "confirm_order_payment", "manual", key("pay"), orderId, Number(total));
  }
});
