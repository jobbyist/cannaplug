import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ProviderError,
  type CheckoutRequest,
  type CheckoutSession,
  type FetchLike,
  type Mode,
  type PaymentProvider,
  type VerifyOutcome,
  type VerifiedFacts,
} from "./provider";

/**
 * Yoco Checkout API.
 *  - Create checkout:  POST {base}/api/checkouts  (Bearer secret key, amount in cents, ZAR only)
 *  - Webhook verification (Standard Webhooks, per Yoco "Verifying events"):
 *      signed content = `${webhook-id}.${webhook-timestamp}.${rawBody}`
 *      key            = base64-decode(webhookSecret without the "whsec_" prefix)
 *      signature      = base64(HMAC-SHA256(key, signed content)), header `webhook-signature` = "v1,<sig> [v1,<sig>…]"
 *      timestamp must be within 3 minutes of now (replay protection); comparison is constant-time.
 */
export const YOCO_TOLERANCE_SECONDS = 180;

export interface YocoConfig {
  secretKey: string;
  webhookSecret: string;
  apiBase?: string | undefined;
}

export function yocoModeFromKey(secretKey: string): Mode {
  return secretKey.startsWith("sk_live_") ? "live" : "test";
}

export function yocoFromEnv(env: Record<string, string | undefined>): YocoConfig | null {
  const secretKey = env["YOCO_SECRET_KEY"]?.trim();
  const webhookSecret = env["YOCO_WEBHOOK_SECRET"]?.trim();
  if (!secretKey || !webhookSecret) return null;
  return { secretKey, webhookSecret, apiBase: env["YOCO_API_BASE"]?.trim() || undefined };
}

export function signYocoPayload(
  secret: string,
  id: string,
  timestamp: string,
  raw: string,
): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function verifyYocoWebhook(
  secret: string,
  raw: string,
  headers: Headers,
  nowSeconds = Math.floor(Date.now() / 1000),
):
  | { ok: true }
  | {
      ok: false;
      reason: "missing_headers" | "bad_timestamp" | "stale_timestamp" | "invalid_signature";
    } {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (!/^\d{9,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(nowSeconds - Number(timestamp)) > YOCO_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expected = signYocoPayload(secret, id, timestamp, raw);
  // The header may carry several space-separated signatures (key rotation); any v1 match is enough.
  const ok = signature
    .split(" ")
    .map((s) => s.trim().split(","))
    .some(([version, sig]) => version === "v1" && !!sig && safeEqual(sig, expected));
  return ok ? { ok: true } : { ok: false, reason: "invalid_signature" };
}

interface YocoEvent {
  id?: unknown;
  type?: unknown;
  payload?: {
    id?: unknown;
    amount?: unknown;
    currency?: unknown;
    mode?: unknown;
    metadata?: { checkoutId?: unknown; transactionId?: unknown } | null;
  };
}

/** Hosted pages must be https; plain http is accepted only for a local mock when the API base is overridden. */
export const isSafeRedirect = (url: string, apiBaseOverride?: string | undefined): boolean =>
  /^https:\/\//.test(url) ||
  (!!apiBaseOverride && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url));

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null;

export function yocoFacts(event: YocoEvent): VerifiedFacts {
  const p = event.payload ?? {};
  const amount = typeof p.amount === "number" && Number.isInteger(p.amount) ? p.amount : null;
  const mode: "live" | "test" | null =
    p.mode === "live" ? "live" : p.mode === "test" ? "test" : null;
  const base = {
    transaction_id: str(p.metadata?.transactionId),
    provider_ref: str(p.metadata?.checkoutId),
    provider_payment_id: str(p.id),
    amount_minor: amount,
    currency: str(p.currency),
    mode,
    merchant_id: null,
  };
  if (event.type === "payment.succeeded") return { kind: "payment_succeeded", ...base };
  if (event.type === "payment.failed")
    return { kind: "payment_failed", ...base, reason: "payment failed at Yoco" };
  return { kind: "ignored", ...base };
}

export function createYocoProvider(
  cfg: YocoConfig,
  fetchFn: FetchLike,
  now = () => Date.now(),
): PaymentProvider {
  const base = (cfg.apiBase ?? "https://payments.yoco.com").replace(/\/+$/, "");
  return {
    id: "yoco",
    mode: yocoModeFromKey(cfg.secretKey),
    merchantId: null,

    async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
      if (req.currency !== "ZAR") throw new ProviderError("Yoco only charges ZAR");
      const res = await fetchFn(`${base}/api/checkouts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.secretKey}`,
          "Content-Type": "application/json",
          // One checkout per transaction, even if we retry the call.
          "Idempotency-Key": req.transactionId,
        },
        body: JSON.stringify({
          amount: Math.round(req.amount * 100),
          currency: "ZAR",
          successUrl: req.successUrl,
          cancelUrl: req.cancelUrl,
          failureUrl: req.failureUrl,
          clientReferenceId: req.transactionId,
          externalId: req.orderNumber,
          metadata: { transactionId: req.transactionId, orderNumber: req.orderNumber },
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new ProviderError(`Yoco checkout failed (${res.status})`, res.status);
      let body: { id?: unknown; redirectUrl?: unknown; amount?: unknown; currency?: unknown };
      try {
        body = JSON.parse(text);
      } catch {
        throw new ProviderError("Yoco returned an unreadable response");
      }
      const id = str(body.id);
      const redirectUrl = str(body.redirectUrl);
      if (!id || !redirectUrl || !isSafeRedirect(redirectUrl, cfg.apiBase))
        throw new ProviderError("Yoco returned no checkout");
      // Defence in depth: the provider must echo the amount we asked for.
      if (body.amount !== Math.round(req.amount * 100) || body.currency !== "ZAR") {
        throw new ProviderError("Yoco checkout amount did not match the order");
      }
      return { providerRef: id, redirectUrl };
    },

    async verifyWebhook(raw: string, headers: Headers): Promise<VerifyOutcome> {
      const v = verifyYocoWebhook(cfg.webhookSecret, raw, headers, Math.floor(now() / 1000));
      if (!v.ok) return { ok: false, reason: v.reason };
      let event: YocoEvent;
      try {
        event = JSON.parse(raw);
      } catch {
        return { ok: false, reason: "malformed_body" };
      }
      const eventKey = str(event.id);
      const eventType = str(event.type);
      if (!eventKey || !eventType || eventKey.length < 6)
        return { ok: false, reason: "malformed_body" };
      return { ok: true, event: { eventKey, eventType, payload: event, facts: yocoFacts(event) } };
    },
  };
}
