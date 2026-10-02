import { describe, expect, it, vi } from "vitest";
import type { FetchLike, PaymentProvider } from "@/lib/payments/provider";
import { createPayPalProvider } from "@/lib/payments/paypal";
import {
  confirmPayPalReturn,
  handleWebhook,
  startPayment,
  type PaymentsDb,
  type PaymentsDeps,
  type TxView,
} from "@/lib/payments/service";
import { createYocoProvider, signYocoPayload } from "@/lib/payments/yoco";
import { rpc, uid, val, type Sql } from "./helpers";

/**
 * Sandbox-style integration: the REAL provider adapters and payments service run against a REAL PostgreSQL
 * schema, with the providers' HTTP APIs replaced by in-process fakes that behave like their sandboxes.
 * Registered inside payments.test.ts so it shares that file's serial execution (FX state is global).
 */
export interface SuiteCtx {
  sql: Sql;
  newOrder(price?: number, qty?: number): Promise<{ member: string; orderId: string }>;
  orderStatus(id: string): Promise<string>;
  payEvents(orderId: string): Promise<number>;
}

const WH_SECRET = `whsec_${Buffer.from("integration-signing-secret-0123456789").toString("base64")}`;
const MERCHANT = "SBX-MERCHANT-1";

function pgDb(sql: Sql): PaymentsDb {
  const cols =
    "id,order_id,provider,status,expected_amount,expected_currency,fx_rate,provider_ref,redirect_url";
  return {
    initiate: (a) =>
      rpc(sql, "payment_initiate", a.userId, a.orderId, a.provider, a.mode, a.merchantId, a.key),
    getTx: async (id) =>
      ((
        await sql.unsafe(`SELECT ${cols} FROM public.payment_transactions WHERE id = $1`, [id])
      )[0] as unknown as TxView) ?? null,
    findPayPalTx: async (u, ref) =>
      ((
        await sql.unsafe(
          `SELECT ${cols} FROM public.payment_transactions WHERE user_id = $1 AND provider = 'paypal' AND provider_ref = $2`,
          [u, ref],
        )
      )[0] as unknown as TxView) ?? null,
    attach: async (t, r, u) => void (await rpc(sql, "payment_attach_session", t, r, u)),
    markFailed: async (t, r) => void (await rpc(sql, "payment_mark_failed", t, r)),
    apply: (p, e) =>
      rpc(sql, "payments_apply_verified_event", p, e.eventKey, e.eventType, e.payload, e.facts),
    reject: async (p, r, ip, h) => void (await rpc(sql, "webhook_reject", p, r, ip, h)),
  };
}

const json = (b: unknown, status = 200) => ({
  ok: status < 300,
  status,
  text: async () => JSON.stringify(b),
});

export function servicePaymentsTests(ctx: SuiteCtx) {
  // `ctx.sql` is only connected in beforeAll, after these tests are registered: resolve it lazily.
  const sql: Sql = new Proxy(function () {} as unknown as Sql, {
    apply: (_t, _this, args) => (ctx.sql as any)(...args),
    get: (_t, prop) => (ctx.sql as any)[prop],
  });

  /** In-process Yoco: records checkouts, echoes what it was asked to charge. */
  function fakeYocoApi() {
    const checkouts: { id: string; body: Record<string, any>; key: string }[] = [];
    const f: FetchLike = async (url, init) => {
      if (url.endsWith("/api/checkouts")) {
        const body = JSON.parse(init!.body!);
        const id = `ch_${uid().slice(0, 8)}`;
        checkouts.push({ id, body, key: init!.headers!["Idempotency-Key"]! });
        return json({
          id,
          redirectUrl: `https://c.yoco.com/checkout/${id}`,
          amount: body.amount,
          currency: body.currency,
          status: "created",
          merchantId: "1",
          processingMode: "test",
        });
      }
      return json({}, 404);
    };
    return { f, checkouts };
  }

  /** In-process PayPal sandbox: orders move CREATED -> (approve) -> COMPLETED on capture. */
  function fakePayPalApi() {
    const orders = new Map<string, any>();
    const state = {
      verify: "SUCCESS",
      approved: false,
      captureValue: null as string | null,
      merchant: MERCHANT,
      createFails: false,
    };
    const f: FetchLike = async (url, init) => {
      if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "tok" });
      if (url.endsWith("/verify-webhook-signature"))
        return json({ verification_status: state.verify });
      if (url.endsWith("/v2/checkout/orders") && init?.method === "POST") {
        if (state.createFails) return json({ name: "INTERNAL" }, 500);
        const body = JSON.parse(init.body!);
        const id = `ORD${uid().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
        orders.set(id, { id, body, status: "CREATED" });
        return json(
          {
            id,
            links: [
              {
                rel: "payer-action",
                href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
              },
            ],
          },
          201,
        );
      }
      const m = /\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/.exec(url);
      if (m) {
        const o = orders.get(m[1]!);
        if (!o) return json({}, 404);
        if (m[2]) {
          if (!state.approved && o.status !== "COMPLETED")
            return json({ details: [{ issue: "ORDER_NOT_APPROVED" }] }, 422);
          o.status = "COMPLETED";
        }
        const pu = o.body.purchase_units[0];
        const view = {
          id: o.id,
          status: o.status,
          purchase_units: [
            {
              custom_id: pu.custom_id,
              payee: { merchant_id: state.merchant },
              payments:
                o.status === "COMPLETED"
                  ? {
                      captures: [
                        {
                          id: `CAP-${o.id}`,
                          status: "COMPLETED",
                          amount: {
                            currency_code: "USD",
                            value: state.captureValue ?? pu.amount.value,
                          },
                        },
                      ],
                    }
                  : {},
            },
          ],
        };
        return json(view, m[2] ? 201 : 200);
      }
      return json({}, 404);
    };
    return { f, orders, state };
  }

  const NOW = () => Date.now();
  function deps(
    over: {
      yocoApi?: FetchLike;
      paypalApi?: FetchLike;
      providers?: Partial<Record<"yoco" | "paypal", PaymentProvider>>;
      db?: PaymentsDb;
    } = {},
  ): PaymentsDeps {
    const providers: PaymentsDeps["providers"] = over.providers ?? {
      yoco: createYocoProvider(
        { secretKey: "sk_test_integration", webhookSecret: WH_SECRET },
        over.yocoApi ?? fakeYocoApi().f,
        NOW,
      ),
      paypal: createPayPalProvider(
        {
          clientId: "c",
          clientSecret: "s",
          webhookId: "WH-1",
          merchantId: MERCHANT,
          env: "sandbox",
        },
        over.paypalApi ?? fakePayPalApi().f,
      ),
    };
    return {
      db: over.db ?? pgDb(sql),
      providers,
      ensureFx: async () => ({ refreshed: false }),
      siteUrl: "https://shop.example",
    };
  }
  const startKey = () => `start-${uid()}`;

  const yocoEvent = (
    tx: { id: string; expected_amount: number | string; provider_ref: string | null },
    over: Record<string, unknown> = {},
    payload: Record<string, unknown> = {},
  ) =>
    JSON.stringify({
      id: `evt_${uid().slice(0, 12)}`,
      type: "payment.succeeded",
      createdDate: new Date().toISOString(),
      payload: {
        id: `p_${uid().slice(0, 10)}`,
        amount: Math.round(Number(tx.expected_amount) * 100),
        currency: "ZAR",
        mode: "test",
        status: "succeeded",
        type: "payment",
        metadata: { checkoutId: tx.provider_ref, transactionId: tx.id },
        ...payload,
      },
      ...over,
    });
  const signedHeaders = (raw: string, o: { ts?: number; secret?: string; id?: string } = {}) => {
    const id = o.id ?? `msg_${uid().slice(0, 8)}`;
    const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
    return new Headers({
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": `v1,${signYocoPayload(o.secret ?? WH_SECRET, id, ts, raw)}`,
    });
  };
  const rejections = () => val<number>(sql`SELECT count(*)::int FROM public.webhook_rejections`);
  const txOf = async (id: string) =>
    (await sql`SELECT * FROM public.payment_transactions WHERE id = ${id}`)[0] as any;

  describe("Yoco end to end (sandbox-style)", () => {
    it("starts a checkout from the DATABASE total, reuses it, and never trusts the return URL", async () => {
      const o = await ctx.newOrder(275);
      const api = fakeYocoApi();
      const d = deps({ yocoApi: api.f });
      const s = await startPayment(d, {
        userId: o.member,
        orderId: o.orderId,
        provider: "yoco",
        key: startKey(),
      });
      expect(s).toMatchObject({ provider: "yoco", amount: 275, currency: "ZAR", fxRate: null });
      expect(s.redirectUrl).toMatch(/^https:\/\/c\.yoco\.com\/checkout\/ch_/);
      expect(api.checkouts[0]!.body["amount"]).toBe(27500);
      expect(api.checkouts[0]!.body["successUrl"]).toContain("/payment/return?order=");
      // the member comes back "successfully" — nothing has been verified, so nothing is paid
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
      const again = await startPayment(d, {
        userId: o.member,
        orderId: o.orderId,
        provider: "yoco",
        key: startKey(),
      });
      expect(again.transactionId).toBe(s.transactionId);
      expect(api.checkouts).toHaveLength(1);
    });

    it("a correctly signed success event pays the order once; replays and concurrent duplicates change nothing", async () => {
      const o = await ctx.newOrder(275);
      const d = deps();
      const s = await startPayment(d, {
        userId: o.member,
        orderId: o.orderId,
        provider: "yoco",
        key: startKey(),
      });
      const tx = (await d.db.getTx(s.transactionId))!;
      const raw = yocoEvent(tx);
      const h = signedHeaders(raw);
      const rs = await Promise.all(
        Array.from({ length: 6 }, () => handleWebhook(d, "yoco", raw, h, "iphash")),
      );
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(await ctx.orderStatus(o.orderId)).toBe("confirmed");
      expect(await ctx.payEvents(o.orderId)).toBe(1);
      expect((await handleWebhook(d, "yoco", raw, h, null)).status).toBe(200); // late redelivery
      expect(await ctx.payEvents(o.orderId)).toBe(1);
      // same payment redelivered under a NEW event id and a fresh signature
      const raw2 = JSON.stringify({ ...JSON.parse(raw), id: `evt_${uid().slice(0, 12)}` });
      expect((await handleWebhook(d, "yoco", raw2, signedHeaders(raw2), null)).status).toBe(200);
      expect(await ctx.payEvents(o.orderId)).toBe(1);
      expect((await txOf(s.transactionId)).status).toBe("succeeded");
    });

    it("invalid messages are refused BEFORE business logic and leave no trace on the order", async () => {
      const o = await ctx.newOrder(275);
      const d = deps();
      const s = await startPayment(d, {
        userId: o.member,
        orderId: o.orderId,
        provider: "yoco",
        key: startKey(),
      });
      const tx = (await d.db.getTx(s.transactionId))!;
      const raw = yocoEvent(tx);
      const apply = vi.spyOn(d.db, "apply");
      const before = await rejections();
      const bad: [string, string, Headers, number][] = [
        ["tampered body", raw.replace(String(27500), "1"), signedHeaders(raw), 401],
        [
          "wrong secret",
          raw,
          signedHeaders(raw, { secret: "whsec_" + Buffer.from("attacker").toString("base64") }),
          401,
        ],
        [
          "stale timestamp",
          raw,
          signedHeaders(raw, { ts: Math.floor(Date.now() / 1000) - 600 }),
          401,
        ],
        ["no headers", raw, new Headers(), 401],
        ["unsigned junk", "{}", new Headers({ "content-type": "application/json" }), 401],
      ];
      for (const [, body, headers, status] of bad)
        expect((await handleWebhook(d, "yoco", body, headers, "ip")).status).toBe(status);
      expect(apply).not.toHaveBeenCalled();
      expect(await rejections()).toBe(before + bad.length);
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
      expect(await ctx.payEvents(o.orderId)).toBe(0);
      expect(
        (await handleWebhook(d, "yoco", "x".repeat(200_000), new Headers(), null)).status,
      ).toBe(413);
      const rows = await sql`SELECT * FROM public.webhook_rejections ORDER BY id DESC LIMIT 1`;
      expect(Object.keys(rows[0]!).some((k) => /payload|body/.test(k))).toBe(false);
    });

    it("a VALID signature does not make a wrong amount, currency, mode or order reference payable", async () => {
      const cases: [string, (tx: TxView) => Record<string, unknown>][] = [
        ["amount", () => ({ amount: 100 })],
        ["currency", () => ({ currency: "USD" })],
        ["mode", () => ({ mode: "live" })],
        [
          "checkout reference",
          () => ({ metadata: { checkoutId: "ch_somebody_else", transactionId: undefined } }),
        ],
      ];
      for (const [name, over] of cases) {
        const o = await ctx.newOrder(275);
        const d = deps();
        const s = await startPayment(d, {
          userId: o.member,
          orderId: o.orderId,
          provider: "yoco",
          key: startKey(),
        });
        const tx = (await d.db.getTx(s.transactionId))!;
        const patch = over(tx);
        if ("metadata" in patch) (patch as any).metadata.transactionId = tx.id;
        const raw = yocoEvent(tx, {}, patch);
        expect((await handleWebhook(d, "yoco", raw, signedHeaders(raw), null)).status, name).toBe(
          200,
        ); // acknowledged, not applied
        expect(await ctx.orderStatus(o.orderId), name).toBe("awaiting_payment");
        expect((await txOf(s.transactionId)).status, name).toBe("review");
      }
    });

    it("an event naming another order's transaction cannot pay this order, and unknown ids pay nothing", async () => {
      const a = await ctx.newOrder(275);
      const b = await ctx.newOrder(275);
      const d = deps();
      const sa = await startPayment(d, {
        userId: a.member,
        orderId: a.orderId,
        provider: "yoco",
        key: startKey(),
      });
      const sb = await startPayment(d, {
        userId: b.member,
        orderId: b.orderId,
        provider: "yoco",
        key: startKey(),
      });
      const txA = (await d.db.getTx(sa.transactionId))!;
      const txB = (await d.db.getTx(sb.transactionId))!;
      // A's checkout id with B's transaction id: the reference does not belong together
      const raw = yocoEvent(
        txB,
        {},
        { metadata: { checkoutId: txA.provider_ref, transactionId: txB.id } },
      );
      await handleWebhook(d, "yoco", raw, signedHeaders(raw), null);
      expect(await ctx.orderStatus(a.orderId)).toBe("awaiting_payment");
      expect(await ctx.orderStatus(b.orderId)).toBe("awaiting_payment");
      const ghost = yocoEvent({ ...txA, id: uid() });
      await handleWebhook(d, "yoco", ghost, signedHeaders(ghost), null);
      expect(await ctx.orderStatus(a.orderId)).toBe("awaiting_payment");
    });

    it("a database failure answers 5xx (so Yoco redelivers) and a retry then succeeds exactly once", async () => {
      const o = await ctx.newOrder(275);
      const real = deps();
      const s = await startPayment(real, {
        userId: o.member,
        orderId: o.orderId,
        provider: "yoco",
        key: startKey(),
      });
      const tx = (await real.db.getTx(s.transactionId))!;
      const raw = yocoEvent(tx);
      const h = signedHeaders(raw);
      const flaky = {
        ...pgDb(sql),
        apply: vi
          .fn()
          .mockRejectedValueOnce(new Error("connection reset"))
          .mockImplementation(pgDb(sql).apply),
      };
      const d = deps({ db: flaky });
      await expect(handleWebhook(d, "yoco", raw, h, null)).rejects.toThrow(); // route turns this into HTTP 500
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
      expect((await handleWebhook(d, "yoco", raw, h, null)).status).toBe(200);
      expect(await ctx.orderStatus(o.orderId)).toBe("confirmed");
      expect(await ctx.payEvents(o.orderId)).toBe(1);
    });

    it("a provider failure at checkout marks the attempt failed and the member can try again", async () => {
      const o = await ctx.newOrder(275);
      const broken: FetchLike = async () => json({ message: "boom" }, 500);
      await expect(
        startPayment(deps({ yocoApi: broken }), {
          userId: o.member,
          orderId: o.orderId,
          provider: "yoco",
          key: startKey(),
        }),
      ).rejects.toMatchObject({ code: "payment_provider_error" });
      const [row] =
        await sql`SELECT status FROM public.payment_transactions WHERE order_id = ${o.orderId}`;
      expect(row!["status"]).toBe("failed");
      const ok = await startPayment(deps(), {
        userId: o.member,
        orderId: o.orderId,
        provider: "yoco",
        key: startKey(),
      });
      expect(ok.redirectUrl).toMatch(/^https:/);
    });

    it("an unconfigured provider is unavailable", async () => {
      const o = await ctx.newOrder(275);
      await expect(
        startPayment(deps({ providers: {} }), {
          userId: o.member,
          orderId: o.orderId,
          provider: "yoco",
          key: startKey(),
        }),
      ).rejects.toMatchObject({ code: "payment_provider_unavailable" });
    });
  });

  describe("PayPal end to end (sandbox-style, USD at the stored rate)", () => {
    it("creates the order with the USD amount stored on the transaction", async () => {
      const o = await ctx.newOrder(275);
      const api = fakePayPalApi();
      const s = await startPayment(deps({ paypalApi: api.f }), {
        userId: o.member,
        orderId: o.orderId,
        provider: "paypal",
        key: startKey(),
      });
      const rate = Number(
        await val<string>(
          sql`SELECT fx_rate FROM public.payment_transactions WHERE id = ${s.transactionId}`,
        ),
      );
      expect(s.currency).toBe("USD");
      expect(s.amount).toBe(Math.ceil((275 / rate) * 100) / 100);
      const order = [...api.orders.values()][0];
      expect(order.body.purchase_units[0].amount).toEqual({
        currency_code: "USD",
        value: s.amount.toFixed(2),
      });
      expect(s.redirectUrl).toContain("paypal.com/checkoutnow");
    });

    it("returning from PayPal WITHOUT approving pays nothing; after approval the server-side capture pays once", async () => {
      const o = await ctx.newOrder(275);
      const api = fakePayPalApi();
      const d = deps({ paypalApi: api.f });
      const s = await startPayment(d, {
        userId: o.member,
        orderId: o.orderId,
        provider: "paypal",
        key: startKey(),
      });
      const token = (await d.db.getTx(s.transactionId))!.provider_ref!;
      await expect(confirmPayPalReturn(d, o.member, token)).rejects.toThrow(); // PayPal: ORDER_NOT_APPROVED
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
      api.state.approved = true;
      expect(await confirmPayPalReturn(d, o.member, token)).toBe("paid");
      expect(await ctx.orderStatus(o.orderId)).toBe("confirmed");
      expect(await confirmPayPalReturn(d, o.member, token)).toBe("paid"); // reload of the return page
      expect(await ctx.payEvents(o.orderId)).toBe(1);
    });

    it("someone else's return token cannot be used to settle (or even look up) a member's payment", async () => {
      const o = await ctx.newOrder(275);
      const other = await ctx.newOrder(275);
      const api = fakePayPalApi();
      api.state.approved = true;
      const d = deps({ paypalApi: api.f });
      const s = await startPayment(d, {
        userId: o.member,
        orderId: o.orderId,
        provider: "paypal",
        key: startKey(),
      });
      const token = (await d.db.getTx(s.transactionId))!.provider_ref!;
      expect(await confirmPayPalReturn(d, other.member, token)).toBe("not_found");
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
      expect(await confirmPayPalReturn(d, o.member, "NOTAREALTOKEN")).toBe("not_found");
    });

    it("a verified webhook then the capture, or the reverse, give one payment; FAILURE verdicts are refused", async () => {
      const o = await ctx.newOrder(275);
      const api = fakePayPalApi();
      api.state.approved = true;
      const d = deps({ paypalApi: api.f });
      const s = await startPayment(d, {
        userId: o.member,
        orderId: o.orderId,
        provider: "paypal",
        key: startKey(),
      });
      const token = (await d.db.getTx(s.transactionId))!.provider_ref!;
      await confirmPayPalReturn(d, o.member, token); // captures
      const raw = JSON.stringify({
        id: `WH-${uid().slice(0, 8)}`,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: { id: `CAP-${token}`, supplementary_data: { related_ids: { order_id: token } } },
      });
      const h = new Headers({
        "paypal-transmission-id": "t",
        "paypal-transmission-time": "2026-10-02T10:00:00Z",
        "paypal-transmission-sig": "c",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/c",
        "paypal-auth-algo": "SHA256withRSA",
      });
      expect((await handleWebhook(d, "paypal", raw, h, null)).status).toBe(200);
      expect(await ctx.payEvents(o.orderId)).toBe(1);
      expect((await txOf(s.transactionId)).status).toBe("succeeded");
      api.state.verify = "FAILURE";
      const before = await rejections();
      expect((await handleWebhook(d, "paypal", raw.replace("WH-", "WH-x"), h, null)).status).toBe(
        401,
      );
      expect(await rejections()).toBe(before + 1);
      api.state.verify = "SUCCESS";
    });

    it("PayPal capturing a different amount or into a different merchant account is held for review, not paid", async () => {
      for (const [name, tweak] of [
        ["amount", (st: any) => (st.captureValue = "1.00")],
        ["merchant", (st: any) => (st.merchant = "SOMEONE-ELSE")],
      ] as const) {
        const o = await ctx.newOrder(275);
        const api = fakePayPalApi();
        api.state.approved = true;
        tweak(api.state);
        const d = deps({ paypalApi: api.f });
        const s = await startPayment(d, {
          userId: o.member,
          orderId: o.orderId,
          provider: "paypal",
          key: startKey(),
        });
        const token = (await d.db.getTx(s.transactionId))!.provider_ref!;
        expect(await confirmPayPalReturn(d, o.member, token), name).toBe("pending");
        expect(await ctx.orderStatus(o.orderId), name).toBe("awaiting_payment");
        expect((await txOf(s.transactionId)).status, name).toBe("review");
      }
    });

    it("an FX outage declines PayPal without touching the order", async () => {
      const o = await ctx.newOrder(275);
      const d = {
        ...deps(),
        ensureFx: async () => {
          throw new Error("no feed");
        },
      };
      await expect(
        startPayment(d, {
          userId: o.member,
          orderId: o.orderId,
          provider: "paypal",
          key: startKey(),
        }),
      ).rejects.toMatchObject({ code: "fx_rate_unavailable" });
      expect(
        await val(
          sql`SELECT count(*)::int FROM public.payment_transactions WHERE order_id = ${o.orderId}`,
        ),
      ).toBe(0);
    });
  });
}
