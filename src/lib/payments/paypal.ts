import { isSafeRedirect } from "./yoco";
import {
  ProviderError,
  toMinor,
  type CheckoutRequest,
  type CheckoutSession,
  type FetchLike,
  type Mode,
  type PaymentProvider,
  type VerifyOutcome,
  type VerifiedFacts,
} from "./provider";

/**
 * PayPal Orders v2.
 *  - Create order (intent CAPTURE, USD — PayPal cannot settle ZAR), customer approves on PayPal.
 *  - Money is only ever recorded from PayPal's own API responses: the order is captured (or looked up)
 *    server-side and the capture's amount/currency/payee are what the database compares. The browser
 *    return URL carries nothing but the order token and proves nothing.
 *  - Webhooks are verified with PayPal's `verify-webhook-signature` postback (transmission headers + the
 *    unmodified raw body + our webhook id), then the order is re-fetched from the API for the facts.
 */
export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  merchantId: string;
  env: "sandbox" | "live";
  apiBase?: string | undefined;
}

export function paypalFromEnv(env: Record<string, string | undefined>): PayPalConfig | null {
  const clientId = env["PAYPAL_CLIENT_ID"]?.trim();
  const clientSecret = env["PAYPAL_CLIENT_SECRET"]?.trim();
  const webhookId = env["PAYPAL_WEBHOOK_ID"]?.trim();
  const merchantId = env["PAYPAL_MERCHANT_ID"]?.trim();
  if (!clientId || !clientSecret || !webhookId || !merchantId) return null;
  return {
    clientId,
    clientSecret,
    webhookId,
    merchantId,
    env: env["PAYPAL_ENV"] === "live" ? "live" : "sandbox",
    apiBase: env["PAYPAL_API_BASE"]?.trim() || undefined,
  };
}

const str = (v: unknown, max = 256): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

interface PayPalOrder {
  id?: unknown;
  status?: unknown;
  purchase_units?: {
    custom_id?: unknown;
    payee?: { merchant_id?: unknown };
    payments?: {
      captures?: {
        id?: unknown;
        status?: unknown;
        amount?: { value?: unknown; currency_code?: unknown };
      }[];
    };
  }[];
}

/** Facts from a PayPal order object returned by PayPal's API (never from the browser). */
export function paypalOrderFacts(order: PayPalOrder, mode: Mode): VerifiedFacts {
  const pu = order.purchase_units?.[0];
  const capture = pu?.payments?.captures?.[0];
  const status = typeof capture?.status === "string" ? capture.status : null;
  const value = capture?.amount?.value;
  const base = {
    transaction_id: str(pu?.custom_id),
    provider_ref: str(order.id),
    provider_payment_id: str(capture?.id),
    amount_minor:
      value !== undefined && Number.isFinite(Number(value)) ? toMinor(value as string) : null,
    currency: str(capture?.amount?.currency_code, 3),
    mode,
    merchant_id: str(pu?.payee?.merchant_id),
  };
  if (status === "COMPLETED") return { kind: "payment_succeeded", ...base };
  if (status === "DECLINED" || status === "FAILED") {
    return { kind: "payment_failed", ...base, reason: `paypal capture ${status.toLowerCase()}` };
  }
  return { kind: "ignored", ...base };
}

export interface PayPalProvider extends PaymentProvider {
  /** Capture an approved order server-side; returns the verified facts and a stable event key. */
  captureOrder(
    orderId: string,
    transactionId: string,
  ): Promise<{ eventKey: string; payload: unknown; facts: VerifiedFacts }>;
}

export function createPayPalProvider(cfg: PayPalConfig, fetchFn: FetchLike): PayPalProvider {
  const base = (
    cfg.apiBase ??
    (cfg.env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com")
  ).replace(/\/+$/, "");
  const mode: Mode = cfg.env === "live" ? "live" : "test";

  async function token(): Promise<string> {
    const res = await fetchFn(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new ProviderError(`PayPal auth failed (${res.status})`, res.status);
    const t = JSON.parse(await res.text()) as { access_token?: unknown };
    const at = str(t.access_token, 2000);
    if (!at) throw new ProviderError("PayPal returned no access token");
    return at;
  }

  async function api(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ) {
    const at = await token();
    const res = await fetchFn(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${at}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    return { ok: res.ok, status: res.status, json };
  }

  const provider: PayPalProvider = {
    id: "paypal",
    mode,
    merchantId: cfg.merchantId,

    async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
      if (req.currency !== "USD") throw new ProviderError("PayPal is charged in USD");
      const r = await api("/v2/checkout/orders", {
        method: "POST",
        headers: { "PayPal-Request-Id": req.transactionId },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: req.transactionId,
              custom_id: req.transactionId,
              invoice_id: `${req.orderNumber}-${req.transactionId.slice(0, 8)}`,
              description: `Cannaplug order ${req.orderNumber}`,
              amount: { currency_code: "USD", value: req.amount.toFixed(2) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: "Cannaplug",
                user_action: "PAY_NOW",
                shipping_preference: "NO_SHIPPING",
                return_url: req.successUrl,
                cancel_url: req.cancelUrl,
              },
            },
          },
        }),
      });
      const body = r.json as { id?: unknown; links?: { rel?: string; href?: string }[] } | null;
      const id = str(body?.id);
      const link = body?.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
      if (!r.ok || !id || !link || !isSafeRedirect(link, cfg.apiBase))
        throw new ProviderError(`PayPal order failed (${r.status})`, r.status);
      return { providerRef: id, redirectUrl: link };
    },

    async captureOrder(orderId, transactionId) {
      if (!/^[A-Za-z0-9-]{5,40}$/.test(orderId)) throw new ProviderError("invalid PayPal order id");
      let r = await api(`/v2/checkout/orders/${orderId}/capture`, {
        method: "POST",
        headers: { "PayPal-Request-Id": `capture-${transactionId}` },
        body: "{}",
      });
      if (!r.ok) {
        // Already captured (e.g. webhook raced the return): the order itself tells us the truth.
        const issue = JSON.stringify(r.json ?? "");
        if (r.status === 422 && issue.includes("ORDER_ALREADY_CAPTURED")) {
          r = await api(`/v2/checkout/orders/${orderId}`, { method: "GET" });
        }
        if (!r.ok) throw new ProviderError(`PayPal capture failed (${r.status})`, r.status);
      }
      const order = r.json as PayPalOrder;
      const facts = paypalOrderFacts(order, mode);
      return { eventKey: `capture:${facts.provider_payment_id ?? orderId}`, payload: order, facts };
    },

    async verifyWebhook(raw: string, headers: Headers): Promise<VerifyOutcome> {
      const h = {
        transmission_id: headers.get("paypal-transmission-id"),
        transmission_time: headers.get("paypal-transmission-time"),
        transmission_sig: headers.get("paypal-transmission-sig"),
        cert_url: headers.get("paypal-cert-url"),
        auth_algo: headers.get("paypal-auth-algo"),
      };
      if (Object.values(h).some((v) => !v)) return { ok: false, reason: "missing_headers" };
      let certHost = "";
      try {
        certHost = new URL(h.cert_url!).hostname;
      } catch {
        return { ok: false, reason: "invalid_signature" };
      }
      if (!/(^|\.)paypal\.com$/.test(certHost)) return { ok: false, reason: "invalid_signature" };
      let event: { id?: unknown; event_type?: unknown; resource?: Record<string, unknown> };
      try {
        event = JSON.parse(raw);
      } catch {
        return { ok: false, reason: "malformed_body" };
      }
      const eventKey = str(event.id);
      const eventType = str(event.event_type);
      if (!eventKey || !eventType) return { ok: false, reason: "malformed_body" };

      // The raw body is spliced in unchanged: re-serialising it would break the signature.
      const postback =
        `{"transmission_id":${JSON.stringify(h.transmission_id)},"transmission_time":${JSON.stringify(h.transmission_time)},` +
        `"cert_url":${JSON.stringify(h.cert_url)},"auth_algo":${JSON.stringify(h.auth_algo)},` +
        `"transmission_sig":${JSON.stringify(h.transmission_sig)},"webhook_id":${JSON.stringify(cfg.webhookId)},` +
        `"webhook_event":${raw}}`;
      let verdict: { ok: boolean; status: number; json: unknown };
      try {
        verdict = await api("/v1/notifications/verify-webhook-signature", {
          method: "POST",
          body: postback,
        });
      } catch {
        return { ok: false, reason: "verification_unavailable" };
      }
      if (!verdict.ok) return { ok: false, reason: "verification_unavailable" };
      if (
        (verdict.json as { verification_status?: string } | null)?.verification_status !== "SUCCESS"
      ) {
        return { ok: false, reason: "invalid_signature" };
      }

      // Verified. Money facts still come from PayPal's API, keyed by the order the capture belongs to.
      const isCapture =
        eventType === "PAYMENT.CAPTURE.COMPLETED" || eventType === "PAYMENT.CAPTURE.DENIED";
      const orderId = str(
        (
          event.resource?.["supplementary_data"] as
            { related_ids?: { order_id?: unknown } } | undefined
        )?.related_ids?.order_id,
      );
      if (!isCapture || !orderId || !/^[A-Za-z0-9-]{5,40}$/.test(orderId)) {
        const ignored: VerifiedFacts = {
          kind: "ignored",
          transaction_id: null,
          provider_ref: null,
          provider_payment_id: null,
          amount_minor: null,
          currency: null,
          mode: null,
          merchant_id: null,
        };
        return { ok: true, event: { eventKey, eventType, payload: event, facts: ignored } };
      }
      let order: { ok: boolean; status: number; json: unknown };
      try {
        order = await api(`/v2/checkout/orders/${orderId}`, { method: "GET" });
      } catch {
        return { ok: false, reason: "verification_unavailable" };
      }
      if (!order.ok) return { ok: false, reason: "verification_unavailable" };
      return {
        ok: true,
        event: {
          eventKey,
          eventType,
          payload: event,
          facts: paypalOrderFacts(order.json as PayPalOrder, mode),
        },
      };
    },
  };
  return provider;
}
