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
import {
  createPayFastProvider,
  pfParamString,
  pfSignature,
  type PayFastConfig,
} from "@/lib/payments/payfast";
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

/** PayFast's published sandbox merchant (public test credentials). */
const PF: PayFastConfig = {
  merchantId: "10000100",
  merchantKey: "46f0cd694581a",
  passphrase: "jt7NOE43FZPn",
  sandbox: true,
};
const PF_IP = "197.97.145.144";
/** PayFast's /eng/query/validate: answers VALID / INVALID, or is down. */
const fakePayFastValidate =
  (answer: "VALID" | "INVALID" | "DOWN"): FetchLike =>
  async (url) =>
    url.endsWith("/eng/query/validate")
      ? { ok: answer !== "DOWN", status: answer === "DOWN" ? 503 : 200, text: async () => answer }
      : { ok: false, status: 404, text: async () => "" };
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

  function deps(
    over: {
      payfastValid?: "VALID" | "INVALID" | "DOWN";
      paypalApi?: FetchLike;
      providers?: Partial<Record<"payfast" | "paypal", PaymentProvider>>;
      db?: PaymentsDb;
    } = {},
  ): PaymentsDeps {
    const providers: PaymentsDeps["providers"] = over.providers ?? {
      payfast: createPayFastProvider(
        PF,
        fakePayFastValidate(over.payfastValid ?? "VALID"),
        async () => [PF_IP],
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

  /** A PayFast ITN for a transaction, signed the way PayFast signs it (fields in the order posted). */
  const itn = (
    tx: { id: string; expected_amount: number | string },
    over: Record<string, string> = {},
    passphrase: string | null = PF.passphrase,
  ) => {
    const gross = Number(tx.expected_amount).toFixed(2);
    const f: Record<string, string> = {
      m_payment_id: tx.id,
      pf_payment_id: `pf${uid().replace(/-/g, "").slice(0, 10)}`,
      payment_status: "COMPLETE",
      item_name: "Cannaplug order",
      item_description: "",
      amount_gross: gross,
      amount_fee: "-6.33",
      amount_net: (Number(gross) - 6.33).toFixed(2),
      custom_str1: "",
      name_first: "Test",
      name_last: "Member",
      email_address: "member@example.com",
      merchant_id: PF.merchantId,
      ...over,
    };
    const pairs = Object.entries(f);
    return `${pfParamString(pairs)}&signature=${pfSignature(pfParamString(pairs), passphrase)}`;
  };
  const rejections = () => val<number>(sql`SELECT count(*)::int FROM public.webhook_rejections`);
  const txOf = async (id: string) =>
    (await sql`SELECT * FROM public.payment_transactions WHERE id = ${id}`)[0] as any;

  describe("PayFast end to end (sandbox-style)", () => {
    const start = (d: PaymentsDeps, o: { member: string; orderId: string }) =>
      startPayment(d, {
        userId: o.member,
        orderId: o.orderId,
        provider: "payfast",
        key: startKey(),
      });

    it("signs a checkout from the DATABASE total, reuses it, and never trusts the return URL", async () => {
      const o = await ctx.newOrder(275);
      const d = deps();
      const s = await start(d, o);
      expect(s).toMatchObject({ provider: "payfast", amount: 275, currency: "ZAR", fxRate: null });
      const url = new URL(s.redirectUrl);
      expect(url.origin + url.pathname).toBe("https://sandbox.payfast.co.za/eng/process");
      const fields = [...url.searchParams.entries()];
      expect(Object.fromEntries(fields)).toMatchObject({
        merchant_id: PF.merchantId,
        amount: "275.00",
        m_payment_id: s.transactionId,
        notify_url: "https://shop.example/api/public/payments/payfast-itn",
      });
      expect(url.searchParams.get("return_url")).toContain("/payment/return?order=");
      // The signature PayFast will check is the one over exactly these fields.
      const unsigned = fields.filter(([k]) => k !== "signature");
      expect(url.searchParams.get("signature")).toBe(
        pfSignature(pfParamString(unsigned), PF.passphrase),
      );
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
      const again = await start(d, o);
      expect(again.transactionId).toBe(s.transactionId);
    });

    it("a verified COMPLETE notification pays the order once; replays and concurrent duplicates change nothing", async () => {
      const o = await ctx.newOrder(275);
      const d = deps();
      const s = await start(d, o);
      const tx = (await d.db.getTx(s.transactionId))!;
      const raw = itn(tx);
      const rs = await Promise.all(
        Array.from({ length: 6 }, () =>
          handleWebhook(d, "payfast", raw, new Headers(), "iphash", PF_IP),
        ),
      );
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(await ctx.orderStatus(o.orderId)).toBe("confirmed");
      expect(await ctx.payEvents(o.orderId)).toBe(1);
      expect((await handleWebhook(d, "payfast", raw, new Headers(), null, PF_IP)).status).toBe(200);
      expect(await ctx.payEvents(o.orderId)).toBe(1);
      expect((await txOf(s.transactionId)).status).toBe("succeeded");
      expect((await txOf(s.transactionId)).provider_payment_id).toMatch(/^pf/);
    });

    it("invalid notifications are refused BEFORE business logic and leave no trace on the order", async () => {
      const o = await ctx.newOrder(275);
      const d = deps();
      const s = await start(d, o);
      const tx = (await d.db.getTx(s.transactionId))!;
      const raw = itn(tx);
      const apply = vi.spyOn(d.db, "apply");
      const before = await rejections();
      const bad: [string, string, PaymentsDeps, string | null, number][] = [
        ["tampered amount", raw.replace("amount_gross=275.00", "amount_gross=1.00"), d, PF_IP, 401],
        ["wrong passphrase", itn(tx, {}, "attacker"), d, PF_IP, 401],
        ["not from PayFast", raw, d, "203.0.113.9", 401],
        ["PayFast says INVALID", raw, deps({ payfastValid: "INVALID" }), PF_IP, 401],
        ["junk", "hello", d, PF_IP, 400],
      ];
      for (const [name, body, dd, ip, status] of bad)
        expect(
          (await handleWebhook(dd, "payfast", body, new Headers(), "ip", ip)).status,
          name,
        ).toBe(status);
      expect(apply).not.toHaveBeenCalled();
      expect(await rejections()).toBe(before + bad.length);
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
      expect(await ctx.payEvents(o.orderId)).toBe(0);
      // PayFast's validation endpoint down: ask PayFast to retry rather than refuse for good.
      expect(
        (
          await handleWebhook(
            deps({ payfastValid: "DOWN" }),
            "payfast",
            raw,
            new Headers(),
            null,
            PF_IP,
          )
        ).status,
      ).toBe(503);
    });

    it("a VALID notification does not make a wrong amount, merchant or transaction payable", async () => {
      const cases: [string, Record<string, string>][] = [
        ["amount", { amount_gross: "100.00" }],
        ["merchant", { merchant_id: "10000999" }],
      ];
      for (const [name, over] of cases) {
        const o = await ctx.newOrder(275);
        const d = deps();
        const s = await start(d, o);
        const tx = (await d.db.getTx(s.transactionId))!;
        expect(
          (await handleWebhook(d, "payfast", itn(tx, over), new Headers(), null, PF_IP)).status,
          name,
        ).toBe(200);
        expect(await ctx.orderStatus(o.orderId), name).toBe("awaiting_payment");
        expect((await txOf(s.transactionId)).status, name).toBe("review");
      }
      const o = await ctx.newOrder(275);
      const d = deps();
      const s = await start(d, o);
      const tx = (await d.db.getTx(s.transactionId))!;
      await handleWebhook(d, "payfast", itn({ ...tx, id: uid() }), new Headers(), null, PF_IP);
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
    });

    it("a CANCELLED notification records the failure and the member can try again", async () => {
      const o = await ctx.newOrder(275);
      const d = deps();
      const s = await start(d, o);
      const tx = (await d.db.getTx(s.transactionId))!;
      await handleWebhook(
        d,
        "payfast",
        itn(tx, { payment_status: "CANCELLED" }),
        new Headers(),
        null,
        PF_IP,
      );
      expect((await txOf(s.transactionId)).status).toBe("failed");
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
      const again = await start(d, o);
      expect(again.transactionId).not.toBe(s.transactionId);
    });

    it("a database failure answers 5xx (so PayFast resends) and a retry then succeeds exactly once", async () => {
      const o = await ctx.newOrder(275);
      const real = deps();
      const s = await start(real, o);
      const raw = itn((await real.db.getTx(s.transactionId))!);
      const flaky = {
        ...pgDb(sql),
        apply: vi
          .fn()
          .mockRejectedValueOnce(new Error("connection reset"))
          .mockImplementation(pgDb(sql).apply),
      };
      const d = deps({ db: flaky });
      await expect(handleWebhook(d, "payfast", raw, new Headers(), null, PF_IP)).rejects.toThrow();
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
      expect((await handleWebhook(d, "payfast", raw, new Headers(), null, PF_IP)).status).toBe(200);
      expect(await ctx.orderStatus(o.orderId)).toBe("confirmed");
      expect(await ctx.payEvents(o.orderId)).toBe(1);
    });

    it("a provider failure at checkout marks the attempt failed; an unconfigured provider is unavailable", async () => {
      const o = await ctx.newOrder(275);
      const broken: PaymentProvider = {
        ...createPayFastProvider(PF, async () => json({}, 500)),
        createCheckout: async () => {
          throw new Error("boom");
        },
      };
      await expect(start(deps({ providers: { payfast: broken } }), o)).rejects.toMatchObject({
        code: "payment_provider_error",
      });
      const [row] =
        await sql`SELECT status FROM public.payment_transactions WHERE order_id = ${o.orderId}`;
      expect(row!["status"]).toBe("failed");
      expect((await start(deps(), o)).redirectUrl).toMatch(/^https:/);
      const o2 = await ctx.newOrder(275);
      await expect(start(deps({ providers: {} }), o2)).rejects.toMatchObject({
        code: "payment_provider_unavailable",
      });
    });
  });

  describe("PayFast onsite window end to end (sandbox-style)", () => {
    /** PayFast's /onsite/process + /eng/query/validate: checks our signature, records what it was asked to charge. */
    function fakeOnsite(down = false) {
      const asked: Record<string, string>[] = [];
      const f: FetchLike = async (url, init) => {
        if (url.endsWith("/eng/query/validate"))
          return { ok: true, status: 200, text: async () => "VALID" };
        if (!url.endsWith("/onsite/process") || down)
          return { ok: false, status: 503, text: async () => "" };
        const pairs = [...new URLSearchParams(init!.body!).entries()];
        const unsigned = pairs.filter(([k]) => k !== "signature");
        const sig = pairs.find(([k]) => k === "signature")?.[1];
        if (sig !== pfSignature(pfParamString(unsigned), PF.passphrase))
          return { ok: false, status: 400, text: async () => "signature mismatch" };
        asked.push(Object.fromEntries(unsigned));
        return { ok: true, status: 200, text: async () => JSON.stringify({ uuid: uid() }) };
      };
      return { f, asked };
    }
    const onsiteDeps = (f: FetchLike) =>
      deps({
        providers: {
          payfast: createPayFastProvider({ ...PF, onsite: true }, f, async () => [PF_IP]),
        },
      });
    const start = (d: PaymentsDeps, o: { member: string; orderId: string }) =>
      startPayment(d, {
        userId: o.member,
        orderId: o.orderId,
        provider: "payfast",
        key: startKey(),
        buyerEmail: "member@example.com",
      });

    it("the window charges the DATABASE total; the window closing 'successfully' pays nothing until a verified ITN", async () => {
      const o = await ctx.newOrder(275, 2);
      const api = fakeOnsite();
      const d = onsiteDeps(api.f);
      const s = await start(d, o);
      expect(s.onsite?.engineUrl).toBe("https://sandbox.payfast.co.za/onsite/engine.js");
      expect(api.asked).toHaveLength(1);
      expect(api.asked[0]).toMatchObject({
        amount: "550.00",
        m_payment_id: s.transactionId,
        email_address: "member@example.com",
        notify_url: "https://shop.example/api/public/payments/payfast-itn",
      });
      // The member saw PayFast's "done" and came back: nothing the browser does changes the order.
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
      expect((await txOf(s.transactionId)).status).toBe("pending");
      // Refreshing / retrying reuses the same transaction with a fresh window.
      const again = await start(d, o);
      expect(again.transactionId).toBe(s.transactionId);
      expect(again.onsite?.uuid).not.toBe(s.onsite?.uuid);
      expect(api.asked[1]!["amount"]).toBe("550.00");
      // PayFast's ITN for that transaction settles it, once.
      const tx = (await d.db.getTx(s.transactionId))!;
      const raw = itn(tx);
      expect((await handleWebhook(d, "payfast", raw, new Headers(), null, PF_IP)).status).toBe(200);
      expect((await handleWebhook(d, "payfast", raw, new Headers(), null, PF_IP)).status).toBe(200);
      expect(await ctx.orderStatus(o.orderId)).toBe("confirmed");
      expect(await ctx.payEvents(o.orderId)).toBe(1);
    });

    it("a forged 'paid' ITN for less than the window's amount does not pay the order", async () => {
      const o = await ctx.newOrder(275);
      const d = onsiteDeps(fakeOnsite().f);
      const s = await start(d, o);
      const tx = (await d.db.getTx(s.transactionId))!;
      await handleWebhook(
        d,
        "payfast",
        itn(tx, { amount_gross: "5.00" }),
        new Headers(),
        null,
        PF_IP,
      ).catch(() => undefined);
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
      // An unsigned/forged one is refused outright.
      const forged = itn(tx, {}, "not-our-passphrase");
      expect((await handleWebhook(d, "payfast", forged, new Headers(), null, PF_IP)).status).toBe(
        401,
      );
      expect(await ctx.orderStatus(o.orderId)).toBe("awaiting_payment");
    });

    it("when PayFast's onsite endpoint is down, the member still gets PayFast's page for the same attempt", async () => {
      const o = await ctx.newOrder(275);
      const s = await start(onsiteDeps(fakeOnsite(true).f), o);
      expect(s.onsite).toBeNull();
      expect(new URL(s.redirectUrl).pathname).toBe("/eng/process");
      expect((await txOf(s.transactionId)).status).toBe("pending");
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
