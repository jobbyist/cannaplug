// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "@/lib/payments/provider";
import { createPayPalProvider, paypalOrderFacts } from "@/lib/payments/paypal";
import {
  PAYFAST_FIELD_ORDER,
  createPayFastProvider,
  parseItn,
  payfastConfigProblems,
  payfastFacts,
  payfastFromEnv,
  pfEncode,
  pfParamString,
  pfSignature,
  signCheckoutFields,
  verifyItnSignature,
  type PayFastConfig,
} from "@/lib/payments/payfast";
import { isPayFastUrl, payFastForm } from "@/lib/payments/redirect";

const TX = "11111111-1111-4111-8111-111111111111";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

// PayFast's published sandbox merchant (public test credentials).
const PF: PayFastConfig = {
  merchantId: "10000100",
  merchantKey: "46f0cd694581a",
  passphrase: "jt7NOE43FZPn",
  sandbox: true,
};
const PF_IP = "197.97.145.144";

const itnPairs = (over: Record<string, string> = {}): [string, string][] =>
  Object.entries({
    m_payment_id: TX,
    pf_payment_id: "1089250",
    payment_status: "COMPLETE",
    item_name: "Cannaplug order CP-1001",
    item_description: "",
    amount_gross: "275.00",
    amount_fee: "-6.33",
    amount_net: "268.67",
    custom_str1: "CP-1001",
    name_first: "Test",
    name_last: "",
    email_address: "member@example.com",
    merchant_id: PF.merchantId,
    ...over,
  });
const itnBody = (pairs = itnPairs(), passphrase: string | null = PF.passphrase) =>
  `${pfParamString(pairs)}&signature=${pfSignature(pfParamString(pairs), passphrase)}`;

const validator = (
  answer: string,
  ok = true,
): FetchLike & { calls: { url: string; body?: string | undefined }[] } => {
  const calls: { url: string; body?: string | undefined }[] = [];
  const f = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body });
    return { ok, status: ok ? 200 : 503, text: async () => answer };
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
};
const provider = (fetchFn: FetchLike = validator("VALID"), ips = [PF_IP]) =>
  createPayFastProvider(PF, fetchFn, async () => ips);

describe("PayFast signature", () => {
  it("encodes the PHP urlencode way: uppercase hex, spaces as +, !'()*~ escaped", () => {
    expect(pfEncode("Cannaplug order #1 (test)!")).toBe("Cannaplug+order+%231+%28test%29%21");
    expect(pfEncode("https://x.co/a?b=c&d=e f")).toBe("https%3A%2F%2Fx.co%2Fa%3Fb%3Dc%26d%3De+f");
    expect(pfEncode("a~b*c'd")).toBe("a%7Eb%2Ac%27d");
  });

  it("is md5 over the ordered param string plus the passphrase, matching an independent computation", () => {
    const pairs: [string, string][] = [
      ["merchant_id", "10000100"],
      ["merchant_key", "46f0cd694581a"],
      ["amount", "275.00"],
      ["item_name", "Cannaplug order CP-1001"],
    ];
    const expected = md5(
      "merchant_id=10000100&merchant_key=46f0cd694581a&amount=275.00&item_name=Cannaplug+order+CP-1001&passphrase=jt7NOE43FZPn",
    );
    expect(pfSignature(pfParamString(pairs), PF.passphrase)).toBe(expected);
    expect(pfSignature(pfParamString(pairs), null)).toBe(
      md5(
        "merchant_id=10000100&merchant_key=46f0cd694581a&amount=275.00&item_name=Cannaplug+order+CP-1001",
      ),
    );
  });

  it("signs checkout fields in PayFast's documented order, dropping blanks, whatever order they are given in", () => {
    const signed = signCheckoutFields(
      {
        item_name: " Cannaplug order CP-1 ",
        amount: "10.00",
        custom_str1: "",
        merchant_key: "k",
        merchant_id: "10000100",
      },
      null,
    );
    expect(signed.map(([k]) => k)).toEqual([
      "merchant_id",
      "merchant_key",
      "amount",
      "item_name",
      "signature",
    ]);
    expect(signed[3]![1]).toBe("Cannaplug order CP-1");
    expect(PAYFAST_FIELD_ORDER.indexOf("m_payment_id")).toBeLessThan(
      PAYFAST_FIELD_ORDER.indexOf("amount"),
    );
  });

  it("ITN signature covers every posted field (blanks included) in the order posted, except signature", () => {
    const pairs = itnPairs();
    const body = itnBody(pairs);
    expect(verifyItnSignature(parseItn(body)!, PF.passphrase)).toBe(true);
    // one character changed anywhere fails
    expect(verifyItnSignature(parseItn(body.replace("275.00", "275.01"))!, PF.passphrase)).toBe(
      false,
    );
    // reordering the fields changes the signed string
    const swapped = [pairs[1]!, pairs[0]!, ...pairs.slice(2)];
    expect(
      verifyItnSignature(
        parseItn(
          `${pfParamString(swapped)}&signature=${pfSignature(pfParamString(pairs), PF.passphrase)}`,
        )!,
        PF.passphrase,
      ),
    ).toBe(false);
    expect(verifyItnSignature(parseItn(itnBody(pairs, "wrong"))!, PF.passphrase)).toBe(false);
    expect(verifyItnSignature(parseItn(pfParamString(pairs))!, PF.passphrase)).toBe(false); // unsigned
  });

  it("parses only form bodies", () => {
    expect(parseItn("")).toBeNull();
    expect(parseItn("hello")).toBeNull();
    expect(parseItn('{"a":1}')).toBeNull();
    expect(parseItn("a=1\nb=2")).toBeNull();
    expect(parseItn("Bad-Key=1")).toBeNull();
    expect(parseItn("a=1&b=two+words")).toEqual([
      ["a", "1"],
      ["b", "two words"],
    ]);
  });
});

describe("PayFast configuration", () => {
  it("needs a numeric merchant id and a key; sandbox only when asked", () => {
    expect(payfastFromEnv({})).toBeNull();
    expect(payfastFromEnv({ PAYFAST_MERCHANT_ID: "abc", PAYFAST_MERCHANT_KEY: "k" })).toBeNull();
    expect(
      payfastFromEnv({ PAYFAST_MERCHANT_ID: "10000100", PAYFAST_MERCHANT_KEY: "k" }),
    ).toMatchObject({ sandbox: false, passphrase: null });
    expect(
      payfastFromEnv({
        PAYFAST_MERCHANT_ID: "10000100",
        PAYFAST_MERCHANT_KEY: "k",
        PAYFAST_PASSPHRASE: " p ",
        PAYFAST_ENV: "Sandbox",
      }),
    ).toMatchObject({ sandbox: true, passphrase: "p" });
  });
});

describe("PayFast checkout", () => {
  const req = {
    transactionId: TX,
    orderNumber: "CP-1001",
    amount: 275,
    currency: "ZAR" as const,
    successUrl: "https://shop.example/payment/return?order=o&provider=payfast&result=success",
    cancelUrl: "https://shop.example/payment/return?order=o&provider=payfast&result=cancelled",
    failureUrl: "https://shop.example/payment/return?order=o&provider=payfast&result=failed",
    notifyUrl: "https://shop.example/api/public/payments/payfast-itn",
  };

  it("returns a signed process URL for the stored amount; no network call, no product names", async () => {
    const f = validator("VALID");
    const s = await provider(f).createCheckout(req);
    expect(f.calls).toHaveLength(0);
    expect(s.providerRef).toBe(TX);
    const u = new URL(s.redirectUrl);
    expect(u.origin + u.pathname).toBe("https://sandbox.payfast.co.za/eng/process");
    const fields = [...u.searchParams.entries()];
    expect(Object.fromEntries(fields)).toMatchObject({
      merchant_id: "10000100",
      amount: "275.00",
      m_payment_id: TX,
      item_name: "Cannaplug order CP-1001",
      notify_url: req.notifyUrl,
    });
    const unsigned = fields.filter(([k]) => k !== "signature");
    expect(u.searchParams.get("signature")).toBe(
      pfSignature(pfParamString(unsigned), PF.passphrase),
    );
    expect(createPayFastProvider({ ...PF, sandbox: false }, f).processUrl).toBe(
      "https://www.payfast.co.za/eng/process",
    );
  });

  it("refuses USD, amounts under R5 and a missing notify URL", async () => {
    const p = provider();
    await expect(p.createCheckout({ ...req, currency: "USD" })).rejects.toThrow("ZAR");
    await expect(p.createCheckout({ ...req, amount: 4.99 })).rejects.toThrow("R5.00");
    await expect(p.createCheckout({ ...req, notifyUrl: undefined } as never)).rejects.toThrow(
      "notify",
    );
  });

  it("the browser posts exactly the signed fields to PayFast; other URLs are plain navigations", async () => {
    const s = await provider().createCheckout(req);
    expect(isPayFastUrl(s.redirectUrl)).toBe(true);
    expect(isPayFastUrl("https://www.sandbox.paypal.com/checkoutnow?token=X")).toBe(false);
    expect(isPayFastUrl("http://www.payfast.co.za/eng/process")).toBe(false);
    expect(isPayFastUrl("https://payfast.co.za.evil.example/eng/process")).toBe(false);
    const form = payFastForm(s.redirectUrl, document);
    expect(form.method.toUpperCase()).toBe("POST");
    expect(form.action).toBe("https://sandbox.payfast.co.za/eng/process");
    const posted = [...form.querySelectorAll("input")].map((i) => [i.name, i.value]);
    expect(posted).toEqual([...new URL(s.redirectUrl).searchParams.entries()]);
  });
});

describe("PayFast configuration problems and onsite switch", () => {
  const base = { PAYFAST_MERCHANT_ID: "10000100", PAYFAST_MERCHANT_KEY: "46f0cd694581a" };
  it("onsite is off unless PAYFAST_ONSITE is explicitly true", () => {
    expect(payfastFromEnv(base)!.onsite).toBe(false);
    expect(payfastFromEnv({ ...base, PAYFAST_ONSITE: "false" })!.onsite).toBe(false);
    expect(payfastFromEnv({ ...base, PAYFAST_ONSITE: "maybe" })!.onsite).toBe(false);
    expect(payfastFromEnv({ ...base, PAYFAST_ONSITE: " TRUE " })!.onsite).toBe(true);
  });
  it("an unknown PAYFAST_ENV switches PayFast off instead of guessing live or sandbox", () => {
    expect(payfastFromEnv({ ...base, PAYFAST_ENV: "sandbx" })).toBeNull();
    expect(payfastFromEnv({ ...base, PAYFAST_ENV: "staging" })).toBeNull();
    expect(payfastFromEnv({ ...base, PAYFAST_ENV: "Production" })!.sandbox).toBe(false);
    expect(payfastFromEnv({ ...base, PAYFAST_ENV: "" })!.sandbox).toBe(false);
    expect(payfastFromEnv({ ...base, PAYFAST_ENV: "live" })!.sandbox).toBe(false);
  });
  it("explains each misconfiguration by variable name, never by value", () => {
    expect(payfastConfigProblems({})).toEqual([]);
    expect(payfastConfigProblems({ ...base, PAYFAST_PASSPHRASE: "jt7NOE43FZPn" })).toEqual([]);
    const p = payfastConfigProblems({
      PAYFAST_MERCHANT_ID: "abc-secretish",
      PAYFAST_PASSPHRASE: "jt7NOE43FZPn",
      PAYFAST_ENV: "sandbx",
      PAYFAST_ONSITE: "perhaps",
    });
    expect(p.join("\n")).toMatch(/PAYFAST_MERCHANT_ID must be the numeric/);
    expect(p.join("\n")).toMatch(/PAYFAST_MERCHANT_KEY is missing/);
    expect(p.join("\n")).toMatch(/PAYFAST_ENV must be "live" or "sandbox"/);
    expect(p.join("\n")).toMatch(/PAYFAST_ONSITE must be/);
    expect(p.join("\n")).not.toMatch(/jt7NOE43FZPn|abc-secretish|sandbx|perhaps/);
    expect(payfastConfigProblems(base).join()).toMatch(/PAYFAST_PASSPHRASE is not set/);
  });
});

describe("PayFast onsite (payment window on our page)", () => {
  const req = {
    transactionId: TX,
    orderNumber: "CP-1001",
    amount: 275,
    currency: "ZAR" as const,
    successUrl: "https://shop.example/payment/return?order=o&provider=payfast&result=success",
    cancelUrl: "https://shop.example/payment/return?order=o&provider=payfast&result=cancelled",
    failureUrl: "https://shop.example/payment/return?order=o&provider=payfast&result=failed",
    notifyUrl: "https://shop.example/api/public/payments/payfast-itn",
  };
  const onsiteApi = (
    answer: { status?: number; body?: string } = {},
  ): FetchLike & { calls: { url: string; body?: string | undefined; headers?: unknown }[] } => {
    const calls: { url: string; body?: string | undefined; headers?: unknown }[] = [];
    const f = (async (url: string, init?: { body?: string; headers?: unknown }) => {
      calls.push({ url, body: init?.body, headers: init?.headers });
      const status = answer.status ?? 200;
      return {
        ok: status < 300,
        status,
        text: async () =>
          answer.body ?? JSON.stringify({ uuid: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" }),
      };
    }) as FetchLike & { calls: typeof calls };
    f.calls = calls;
    return f;
  };
  const onsite = (f: FetchLike, over: Partial<PayFastConfig> = {}) =>
    createPayFastProvider({ ...PF, onsite: true, ...over }, f, async () => [PF_IP]);

  it("posts the signed fields (with the member's email) server-to-server and returns PayFast's uuid", async () => {
    const f = onsiteApi();
    const s = await onsite(f).createOnsitePayment(req, { email: "member@example.com" });
    expect(s).toEqual({
      uuid: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      engineUrl: "https://sandbox.payfast.co.za/onsite/engine.js",
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://sandbox.payfast.co.za/onsite/process");
    expect(f.calls[0]!.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const pairs = [...new URLSearchParams(f.calls[0]!.body!).entries()];
    const fields = Object.fromEntries(pairs);
    expect(fields).toMatchObject({
      merchant_id: PF.merchantId,
      merchant_key: PF.merchantKey,
      amount: "275.00",
      m_payment_id: TX,
      email_address: "member@example.com",
      notify_url: req.notifyUrl,
      item_name: "Cannaplug order CP-1001",
    });
    // Fields go in PayFast's documented order and the signature covers exactly what was posted.
    const keys = pairs.map(([k]) => k).filter((k) => k !== "signature");
    expect(keys).toEqual(PAYFAST_FIELD_ORDER.filter((k) => keys.includes(k)));
    const unsigned = f.calls[0]!.body!.replace(/&signature=[a-f0-9]{32}$/, "");
    expect(fields["signature"]).toBe(md5(`${unsigned}&passphrase=${pfEncode(PF.passphrase!)}`));
    expect(f.calls[0]!.body).not.toContain("passphrase");
    // Live uses the live engine and endpoint.
    const live = onsiteApi();
    const l = await onsite(live, { sandbox: false }).createOnsitePayment(req, {
      email: "member@example.com",
    });
    expect(l.engineUrl).toBe("https://www.payfast.co.za/onsite/engine.js");
    expect(live.calls[0]!.url).toBe("https://www.payfast.co.za/onsite/process");
  });

  it("is refused when switched off, without an email, or for amounts PayFast would refuse", async () => {
    const f = onsiteApi();
    const off = createPayFastProvider(PF, f, async () => [PF_IP]);
    expect(off.onsite).toBe(false);
    await expect(off.createOnsitePayment(req, { email: "m@example.com" })).rejects.toThrow(
      "not enabled",
    );
    const p = onsite(f);
    await expect(p.createOnsitePayment(req, { email: null })).rejects.toThrow("email");
    await expect(p.createOnsitePayment(req, { email: "not-an-email" })).rejects.toThrow("email");
    await expect(
      p.createOnsitePayment({ ...req, currency: "USD" }, { email: "m@example.com" }),
    ).rejects.toThrow("ZAR");
    await expect(
      p.createOnsitePayment({ ...req, amount: 4.99 }, { email: "m@example.com" }),
    ).rejects.toThrow("R5.00");
    expect(f.calls).toHaveLength(0);
  });

  it("a refusal, an outage, or an odd answer is an error that never echoes PayFast's body", async () => {
    const email = { email: "member@example.com" };
    const refused = onsite(onsiteApi({ status: 400, body: "merchant_key=46f0cd694581a invalid" }));
    const err = await refused.createOnsitePayment(req, email).catch((e: Error) => e);
    expect(String(err)).toMatch(/refused/);
    expect(String(err)).not.toContain("46f0cd694581a");
    await expect(
      onsite(onsiteApi({ body: "<html>maintenance</html>" })).createOnsitePayment(req, email),
    ).rejects.toThrow("unexpected");
    await expect(
      onsite(onsiteApi({ body: JSON.stringify({ uuid: 'x"><script>' }) })).createOnsitePayment(
        req,
        email,
      ),
    ).rejects.toThrow("identifier");
    await expect(
      onsite(onsiteApi({ body: JSON.stringify({}) })).createOnsitePayment(req, email),
    ).rejects.toThrow("identifier");
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as FetchLike;
    await expect(onsite(down).createOnsitePayment(req, email)).rejects.toThrow("unreachable");
  });
});

describe("PayFast ITN security checks", () => {
  it("accepts a signed ITN from a PayFast address that PayFast confirms VALID, and maps it to facts", async () => {
    const f = validator("VALID");
    const pairs = itnPairs();
    const v = await provider(f).verifyWebhook(itnBody(pairs), new Headers(), { sourceIp: PF_IP });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.event.eventKey).toBe("1089250:COMPLETE");
    expect(v.event.facts).toEqual({
      kind: "payment_succeeded",
      transaction_id: TX,
      provider_ref: TX,
      provider_payment_id: "1089250",
      amount_minor: 27500,
      currency: "ZAR",
      mode: "test",
      merchant_id: "10000100",
    });
    expect(JSON.stringify(v.event.payload)).not.toContain("signature");
    // check 4: the same param string (no signature) went to PayFast's validate endpoint
    expect(f.calls).toEqual([
      { url: "https://sandbox.payfast.co.za/eng/query/validate", body: pfParamString(pairs) },
    ]);
  });

  it("refuses a bad signature and a foreign address before asking PayFast anything", async () => {
    const f = validator("VALID");
    const p = provider(f);
    expect(
      await p.verifyWebhook(itnBody(itnPairs(), "attacker"), new Headers(), { sourceIp: PF_IP }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
    expect(await p.verifyWebhook(itnBody(), new Headers(), { sourceIp: "203.0.113.9" })).toEqual({
      ok: false,
      reason: "verification_failed",
    });
    expect(await p.verifyWebhook(itnBody(), new Headers(), { sourceIp: null })).toEqual({
      ok: false,
      reason: "verification_failed",
    });
    expect(await p.verifyWebhook("junk", new Headers(), { sourceIp: PF_IP })).toEqual({
      ok: false,
      reason: "malformed_body",
    });
    expect(f.calls).toHaveLength(0);
  });

  it("an INVALID answer is a refusal; a validation or DNS outage is retryable", async () => {
    const ctx = { sourceIp: PF_IP };
    expect(
      await provider(validator("INVALID")).verifyWebhook(itnBody(), new Headers(), ctx),
    ).toEqual({
      ok: false,
      reason: "verification_failed",
    });
    expect(
      await provider(validator("", false)).verifyWebhook(itnBody(), new Headers(), ctx),
    ).toEqual({ ok: false, reason: "verification_unavailable" });
    const throwing: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await provider(throwing).verifyWebhook(itnBody(), new Headers(), ctx)).toEqual({
      ok: false,
      reason: "verification_unavailable",
    });
    expect(
      await provider(validator("VALID"), []).verifyWebhook(itnBody(), new Headers(), ctx),
    ).toEqual({
      ok: false,
      reason: "verification_unavailable",
    });
  });

  it("in live mode the sandbox host is not a trusted source", async () => {
    const resolve = vi.fn(async (h: string) =>
      h === "sandbox.payfast.co.za" ? [PF_IP] : ["198.51.100.1"],
    );
    const live = createPayFastProvider({ ...PF, sandbox: false }, validator("VALID"), resolve);
    expect(await live.verifyWebhook(itnBody(), new Headers(), { sourceIp: PF_IP })).toEqual({
      ok: false,
      reason: "verification_failed",
    });
    expect(resolve.mock.calls.map(([h]) => h)).not.toContain("sandbox.payfast.co.za");
  });

  it("maps FAILED and CANCELLED to failures, other statuses to ignored, and never trusts a malformed amount", () => {
    const facts = (o: Record<string, string>) => payfastFacts(new Map(itnPairs(o)), "live");
    expect(facts({ payment_status: "FAILED" })).toMatchObject({ kind: "payment_failed" });
    expect(facts({ payment_status: "CANCELLED" })).toMatchObject({ kind: "payment_failed" });
    expect(facts({ payment_status: "PENDING" })).toMatchObject({ kind: "ignored" });
    expect(facts({ amount_gross: "27,500" }).amount_minor).toBeNull();
    expect(facts({ amount_gross: "275.001" }).amount_minor).toBeNull();
    expect(facts({ amount_gross: "0.10" }).amount_minor).toBe(10);
    expect(facts({}).mode).toBe("live");
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
