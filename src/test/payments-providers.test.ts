import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "@/lib/payments/provider";
import { createPayPalProvider, paypalOrderFacts } from "@/lib/payments/paypal";
import {
  YOCO_TOLERANCE_SECONDS,
  createYocoProvider,
  signYocoPayload,
  verifyYocoWebhook,
  yocoFacts,
} from "@/lib/payments/yoco";

const SECRET = `whsec_${Buffer.from("super-secret-signing-key-0123456789").toString("base64")}`;
const NOW = 1_800_000_000;
const TX = "11111111-1111-4111-8111-111111111111";

const yocoBody = (over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "evt_abc12345",
    type: "payment.succeeded",
    createdDate: "2026-10-02T10:00:00Z",
    payload: {
      id: "p_999",
      amount: 27500,
      currency: "ZAR",
      mode: "test",
      status: "succeeded",
      type: "payment",
      metadata: { checkoutId: "ch_1", transactionId: TX },
      ...payload,
    },
    ...over,
  });
const signed = (raw: string, over: { id?: string; ts?: number; secret?: string } = {}) => {
  const id = over.id ?? "msg_1";
  const ts = String(over.ts ?? NOW);
  return new Headers({
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${signYocoPayload(over.secret ?? SECRET, id, ts, raw)}`,
  });
};

describe("Yoco webhook verification (Standard Webhooks)", () => {
  const raw = yocoBody();
  it("accepts a correctly signed, fresh message", () => {
    expect(verifyYocoWebhook(SECRET, raw, signed(raw), NOW)).toEqual({ ok: true });
  });
  it("matches the published algorithm independently of our helper", async () => {
    const { createHmac } = await import("node:crypto");
    const key = Buffer.from(SECRET.slice(6), "base64");
    const sig = createHmac("sha256", key).update(`msg_1.${NOW}.${raw}`).digest("base64");
    const h = new Headers({
      "webhook-id": "msg_1",
      "webhook-timestamp": String(NOW),
      "webhook-signature": `v1,${sig}`,
    });
    expect(verifyYocoWebhook(SECRET, raw, h, NOW).ok).toBe(true);
  });
  it("rejects a tampered body, even by one character", () => {
    const h = signed(raw);
    expect(verifyYocoWebhook(SECRET, raw.replace("27500", "27400"), h, NOW)).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
    expect(verifyYocoWebhook(SECRET, raw + " ", h, NOW).ok).toBe(false);
  });
  it("rejects a wrong secret, a swapped webhook id, and a swapped timestamp", () => {
    expect(
      verifyYocoWebhook(
        SECRET,
        raw,
        signed(raw, { secret: "whsec_" + Buffer.from("other").toString("base64") }),
        NOW,
      ).ok,
    ).toBe(false);
    const h = signed(raw);
    h.set("webhook-id", "msg_2");
    expect(verifyYocoWebhook(SECRET, raw, h, NOW).ok).toBe(false);
    const t = signed(raw);
    t.set("webhook-timestamp", String(NOW + 1));
    expect(verifyYocoWebhook(SECRET, raw, t, NOW).ok).toBe(false);
  });
  it("rejects stale and future timestamps beyond 3 minutes (replay protection)", () => {
    expect(YOCO_TOLERANCE_SECONDS).toBe(180);
    expect(verifyYocoWebhook(SECRET, raw, signed(raw, { ts: NOW - 181 }), NOW)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
    expect(verifyYocoWebhook(SECRET, raw, signed(raw, { ts: NOW + 181 }), NOW).ok).toBe(false);
    expect(verifyYocoWebhook(SECRET, raw, signed(raw, { ts: NOW - 179 }), NOW).ok).toBe(true);
  });
  it("rejects missing headers and malformed timestamps", () => {
    for (const drop of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const h = signed(raw);
      h.delete(drop);
      expect(verifyYocoWebhook(SECRET, raw, h, NOW)).toEqual({
        ok: false,
        reason: "missing_headers",
      });
    }
    const h = signed(raw);
    h.set("webhook-timestamp", "yesterday");
    expect(verifyYocoWebhook(SECRET, raw, h, NOW)).toEqual({ ok: false, reason: "bad_timestamp" });
  });
  it("accepts any one valid signature among several, rejects a non-v1 or junk one", () => {
    const h = signed(raw);
    const good = h.get("webhook-signature")!;
    h.set("webhook-signature", `v1,AAAA ${good}`);
    expect(verifyYocoWebhook(SECRET, raw, h, NOW).ok).toBe(true);
    h.set("webhook-signature", good.replace("v1,", "v2,"));
    expect(verifyYocoWebhook(SECRET, raw, h, NOW).ok).toBe(false);
    h.set("webhook-signature", "v1,");
    expect(verifyYocoWebhook(SECRET, raw, h, NOW).ok).toBe(false);
  });

  it("the provider turns a verified event into facts and refuses a bad one before parsing", async () => {
    const p = createYocoProvider(
      { secretKey: "sk_test_x", webhookSecret: SECRET },
      vi.fn() as unknown as FetchLike,
      () => NOW * 1000,
    );
    const ok = await p.verifyWebhook(raw, signed(raw));
    expect(ok).toMatchObject({
      ok: true,
      event: {
        eventKey: "evt_abc12345",
        eventType: "payment.succeeded",
        facts: {
          kind: "payment_succeeded",
          transaction_id: TX,
          provider_ref: "ch_1",
          provider_payment_id: "p_999",
          amount_minor: 27500,
          currency: "ZAR",
          mode: "test",
        },
      },
    });
    expect(await p.verifyWebhook(raw, new Headers())).toEqual({
      ok: false,
      reason: "missing_headers",
    });
    const notJson = "not json";
    expect(await p.verifyWebhook(notJson, signed(notJson))).toEqual({
      ok: false,
      reason: "malformed_body",
    });
    const noId = JSON.stringify({ type: "payment.succeeded", payload: {} });
    expect(await p.verifyWebhook(noId, signed(noId))).toEqual({
      ok: false,
      reason: "malformed_body",
    });
  });
  it("maps failed and unknown event types; never trusts a non-integer amount", () => {
    expect(yocoFacts(JSON.parse(yocoBody({ type: "payment.failed" }))).kind).toBe("payment_failed");
    expect(yocoFacts(JSON.parse(yocoBody({ type: "refund.succeeded" }))).kind).toBe("ignored");
    expect(yocoFacts(JSON.parse(yocoBody({}, { amount: 275.5 }))).amount_minor).toBeNull();
    expect(yocoFacts(JSON.parse(yocoBody({}, { amount: "27500" }))).amount_minor).toBeNull();
    expect(yocoFacts(JSON.parse(yocoBody({}, { mode: "sandbox" }))).mode).toBeNull();
  });
});

describe("Yoco checkout creation", () => {
  const res =
    (body: unknown, status = 200) =>
    async () => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
  const req = {
    transactionId: TX,
    orderNumber: "CP-100",
    amount: 275,
    currency: "ZAR" as const,
    successUrl: "https://s/ok",
    cancelUrl: "https://s/c",
    failureUrl: "https://s/f",
  };
  it("sends the authoritative amount in cents with an idempotency key, and returns the hosted URL", async () => {
    const f = vi.fn(
      res({
        id: "ch_1",
        redirectUrl: "https://c.yoco.com/checkout/1",
        amount: 27500,
        currency: "ZAR",
      }),
    );
    const p = createYocoProvider(
      { secretKey: "sk_test_x", webhookSecret: SECRET },
      f as unknown as FetchLike,
    );
    expect(await p.createCheckout(req)).toEqual({
      providerRef: "ch_1",
      redirectUrl: "https://c.yoco.com/checkout/1",
    });
    const [url, init] = f.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://payments.yoco.com/api/checkouts");
    expect(init.headers["Idempotency-Key"]).toBe(TX);
    expect(init.headers["Authorization"]).toBe("Bearer sk_test_x");
    expect(JSON.parse(init.body)).toMatchObject({
      amount: 27500,
      currency: "ZAR",
      metadata: { transactionId: TX },
    });
  });
  it("refuses a USD request, a provider error, a non-https redirect, and an echoed amount that differs", async () => {
    const mk = (r: ReturnType<typeof res>) =>
      createYocoProvider(
        { secretKey: "sk_test_x", webhookSecret: SECRET },
        r as unknown as FetchLike,
      );
    await expect(
      mk(res({}))!.createCheckout({ ...req, currency: "USD" as never }),
    ).rejects.toThrow();
    await expect(mk(res({}, 500)).createCheckout(req)).rejects.toThrow("Yoco checkout failed");
    await expect(
      mk(
        res({ id: "c", redirectUrl: "http://evil", amount: 27500, currency: "ZAR" }),
      ).createCheckout(req),
    ).rejects.toThrow();
    await expect(
      mk(
        res({ id: "c", redirectUrl: "https://c.yoco.com/x", amount: 100, currency: "ZAR" }),
      ).createCheckout(req),
    ).rejects.toThrow("did not match");
  });
});

// ---------------------------------------------------------------------------------------------
describe("PayPal", () => {
  const CFG = {
    clientId: "id",
    clientSecret: "sec",
    webhookId: "WH-ID-1",
    merchantId: "MERCH1",
    env: "sandbox" as const,
  };
  const order = (
    over: {
      status?: string;
      value?: string;
      cur?: string;
      merchant?: string;
      custom?: string;
    } = {},
  ) => ({
    id: "ORDER-123",
    status: "COMPLETED",
    purchase_units: [
      {
        custom_id: over.custom ?? TX,
        payee: { merchant_id: over.merchant ?? "MERCH1" },
        payments: {
          captures: [
            {
              id: "CAP-1",
              status: over.status ?? "COMPLETED",
              amount: { value: over.value ?? "14.87", currency_code: over.cur ?? "USD" },
            },
          ],
        },
      },
    ],
  });
  type Call = { url: string; method?: string; body?: string; headers?: Record<string, string> };
  function api(handlers: {
    verify?: unknown;
    order?: unknown;
    verifyStatus?: number;
    captureStatus?: number;
    capture?: unknown;
  }) {
    const calls: Call[] = [];
    const f: FetchLike = async (url, init) => {
      calls.push({ url, ...(init ?? {}) });
      const j = (b: unknown, status = 200) => ({
        ok: status < 300,
        status,
        text: async () => JSON.stringify(b),
      });
      if (url.endsWith("/v1/oauth2/token")) return j({ access_token: "tok" });
      if (url.endsWith("/verify-webhook-signature"))
        return j(
          handlers.verify ?? { verification_status: "SUCCESS" },
          handlers.verifyStatus ?? 200,
        );
      if (url.endsWith("/capture"))
        return j(handlers.capture ?? handlers.order ?? order(), handlers.captureStatus ?? 201);
      if (url.includes("/v2/checkout/orders/") && init?.method === "GET")
        return j(handlers.order ?? order());
      if (url.endsWith("/v2/checkout/orders"))
        return j(
          {
            id: "ORDER-123",
            links: [
              {
                rel: "payer-action",
                href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123",
              },
            ],
          },
          201,
        );
      return j({}, 404);
    };
    return { f, calls };
  }
  const hdrs = (over: Record<string, string | null> = {}) => {
    const base: Record<string, string> = {
      "paypal-transmission-id": "tid-1",
      "paypal-transmission-time": "2026-10-02T10:00:00Z",
      "paypal-transmission-sig": "c2ln",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      "paypal-auth-algo": "SHA256withRSA",
    };
    const h = new Headers(base);
    for (const [k, v] of Object.entries(over)) {
      if (v === null) h.delete(k);
      else h.set(k, v);
    }
    return h;
  };
  const evt = (type = "PAYMENT.CAPTURE.COMPLETED", orderId: string | null = "ORDER-123") =>
    JSON.stringify({
      id: "WH-EVT-1",
      event_type: type,
      resource: {
        id: "CAP-1",
        supplementary_data: orderId ? { related_ids: { order_id: orderId } } : {},
      },
    });

  it("creates a USD order from the stored amount with a request id, and returns the approval URL", async () => {
    const { f, calls } = api({});
    const p = createPayPalProvider(CFG, f);
    const s = await p.createCheckout({
      transactionId: TX,
      orderNumber: "CP-100",
      amount: 14.87,
      currency: "USD",
      successUrl: "https://s/ok",
      cancelUrl: "https://s/c",
      failureUrl: "https://s/f",
    });
    expect(s).toEqual({
      providerRef: "ORDER-123",
      redirectUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123",
    });
    const create = calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!;
    expect(create.headers?.["PayPal-Request-Id"]).toBe(TX);
    const body = JSON.parse(create.body!);
    expect(body.purchase_units[0]).toMatchObject({
      custom_id: TX,
      amount: { currency_code: "USD", value: "14.87" },
    });
    await expect(
      p.createCheckout({
        transactionId: TX,
        orderNumber: "x",
        amount: 275,
        currency: "ZAR",
        successUrl: "",
        cancelUrl: "",
        failureUrl: "",
      }),
    ).rejects.toThrow();
  });

  it("verifies a webhook via the postback with the raw body spliced in unchanged, then reads facts from the API", async () => {
    const { f, calls } = api({});
    const p = createPayPalProvider(CFG, f);
    const raw = evt();
    const r = await p.verifyWebhook(raw, hdrs());
    expect(r).toMatchObject({
      ok: true,
      event: {
        eventKey: "WH-EVT-1",
        facts: {
          kind: "payment_succeeded",
          transaction_id: TX,
          provider_payment_id: "CAP-1",
          amount_minor: 1487,
          currency: "USD",
          merchant_id: "MERCH1",
          provider_ref: "ORDER-123",
          mode: "test",
        },
      },
    });
    const post = calls.find((c) => c.url.endsWith("/verify-webhook-signature"))!;
    expect(post.body!.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(post.body!)).toMatchObject({
      webhook_id: "WH-ID-1",
      transmission_id: "tid-1",
      auth_algo: "SHA256withRSA",
    });
  });
  it("rejects FAILURE, missing headers, a foreign cert host, malformed bodies — without calling the order API", async () => {
    const { f, calls } = api({ verify: { verification_status: "FAILURE" } });
    const p = createPayPalProvider(CFG, f);
    expect(await p.verifyWebhook(evt(), hdrs())).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
    expect(calls.some((c) => c.url.includes("/v2/checkout/orders/"))).toBe(false);
    const { f: f2, calls: c2 } = api({});
    const p2 = createPayPalProvider(CFG, f2);
    expect(await p2.verifyWebhook(evt(), hdrs({ "paypal-transmission-sig": null }))).toEqual({
      ok: false,
      reason: "missing_headers",
    });
    expect(
      await p2.verifyWebhook(evt(), hdrs({ "paypal-cert-url": "https://evil.example.com/cert" })),
    ).toEqual({ ok: false, reason: "invalid_signature" });
    expect(
      await p2.verifyWebhook(evt(), hdrs({ "paypal-cert-url": "https://paypal.com.evil.io/cert" })),
    ).toEqual({ ok: false, reason: "invalid_signature" });
    expect(await p2.verifyWebhook("{nope", hdrs())).toEqual({
      ok: false,
      reason: "malformed_body",
    });
    expect(c2.some((c) => c.url.endsWith("/verify-webhook-signature"))).toBe(false);
  });
  it("a verification API outage is retryable, not a verdict", async () => {
    const { f } = api({ verifyStatus: 503, verify: {} });
    expect(await createPayPalProvider(CFG, f).verifyWebhook(evt(), hdrs())).toEqual({
      ok: false,
      reason: "verification_unavailable",
    });
    const down: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await createPayPalProvider(CFG, down).verifyWebhook(evt(), hdrs())).toEqual({
      ok: false,
      reason: "verification_unavailable",
    });
  });
  it("verified events that carry no capture are stored as ignored", async () => {
    const { f } = api({});
    const p = createPayPalProvider(CFG, f);
    expect(await p.verifyWebhook(evt("CHECKOUT.ORDER.APPROVED"), hdrs())).toMatchObject({
      ok: true,
      event: { facts: { kind: "ignored" } },
    });
    expect(await p.verifyWebhook(evt("PAYMENT.CAPTURE.COMPLETED", null), hdrs())).toMatchObject({
      ok: true,
      event: { facts: { kind: "ignored" } },
    });
    expect(
      await p.verifyWebhook(evt("PAYMENT.CAPTURE.COMPLETED", "../../etc"), hdrs()),
    ).toMatchObject({ ok: true, event: { facts: { kind: "ignored" } } });
  });
  it("captures server-side with a stable request id, and survives an already-captured order", async () => {
    const { f, calls } = api({});
    const cap = await createPayPalProvider(CFG, f).captureOrder("ORDER-123", TX);
    expect(cap.eventKey).toBe("capture:CAP-1");
    expect(cap.facts).toMatchObject({
      kind: "payment_succeeded",
      amount_minor: 1487,
      currency: "USD",
      merchant_id: "MERCH1",
    });
    expect(calls.find((c) => c.url.endsWith("/capture"))!.headers?.["PayPal-Request-Id"]).toBe(
      `capture-${TX}`,
    );
    const again = api({
      captureStatus: 422,
      capture: { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
    });
    expect(
      (await createPayPalProvider(CFG, again.f).captureOrder("ORDER-123", TX)).facts.kind,
    ).toBe("payment_succeeded");
    await expect(
      createPayPalProvider(CFG, api({ captureStatus: 500, capture: {} }).f).captureOrder(
        "ORDER-123",
        TX,
      ),
    ).rejects.toThrow();
    await expect(createPayPalProvider(CFG, f).captureOrder("../x", TX)).rejects.toThrow("invalid");
  });
  it("only a COMPLETED capture is a success; pending and declined are not", () => {
    expect(paypalOrderFacts(order(), "test").kind).toBe("payment_succeeded");
    expect(paypalOrderFacts(order({ status: "PENDING" }), "test").kind).toBe("ignored");
    expect(paypalOrderFacts(order({ status: "DECLINED" }), "test").kind).toBe("payment_failed");
    expect(paypalOrderFacts({ id: "O", purchase_units: [{}] }, "test")).toMatchObject({
      kind: "ignored",
      amount_minor: null,
    });
  });
});
