import { createPayPalProvider, type PayPalConfig } from "@/lib/payments/paypal";
import type { FetchLike } from "@/lib/payments/provider";

/** PayPal events about the Shopify Admin API subscription. Anything else belongs to the shop's order flow. */
export const isSubscriptionEventType = (t: unknown): t is string =>
  typeof t === "string" && (t.startsWith("PAYMENT.SALE.") || t.startsWith("BILLING.SUBSCRIPTION."));

const SALE_EVENTS: Record<string, "COMPLETED" | "REFUNDED" | "REVERSED"> = {
  "PAYMENT.SALE.COMPLETED": "COMPLETED",
  "PAYMENT.SALE.REFUNDED": "REFUNDED",
  "PAYMENT.SALE.REVERSED": "REVERSED",
};
const SUBSCRIPTION_EVENTS: Record<string, string> = {
  "BILLING.SUBSCRIPTION.ACTIVATED": "ACTIVATED",
  "BILLING.SUBSCRIPTION.CANCELLED": "CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED": "SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED": "EXPIRED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED": "PAYMENT_FAILED",
};

export interface PayPalSubscriptionDeps {
  cfg: PayPalConfig | null;
  fetchFn: FetchLike;
  recordSale(a: {
    event: "COMPLETED" | "REFUNDED" | "REVERSED";
    subscriptionId: string;
    paymentId: string;
    saleId: string;
    amountCents: number | null;
    currency: string;
  }): Promise<void>;
  subscriptionEvent(a: { subscriptionId: string; event: string; eventId: string }): Promise<void>;
}

const text = (v: unknown, max = 100): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
const cents = (v: unknown): number | null => {
  const s = typeof v === "string" || typeof v === "number" ? String(v) : "";
  return /^[0-9]{1,9}(\.[0-9]{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : null;
};

/** The event type of an unverified body, only to decide which handler it goes to. */
export function peekEventType(raw: string): string | null {
  try {
    const t = (JSON.parse(raw) as { event_type?: unknown }).event_type;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

/**
 * A PayPal webhook for the Shopify subscription. The signature is checked with the same PayPal postback the shop
 * payments use, BEFORE anything is read from the body. Returns null when the event is not about the subscription,
 * so the caller hands it to the shop flow. Payments are logged once per PayPal sale id; renewals arrive here.
 */
export async function handlePayPalSubscriptionEvent(
  deps: PayPalSubscriptionDeps,
  raw: string,
  headers: Headers,
): Promise<{ status: number; body: string } | null> {
  if (!isSubscriptionEventType(peekEventType(raw))) return null;
  if (!deps.cfg) return { status: 503, body: "unavailable" };
  const verdict = await createPayPalProvider(deps.cfg, deps.fetchFn).verifyWebhook(raw, headers);
  if (!verdict.ok) {
    const status =
      verdict.reason === "verification_unavailable"
        ? 503
        : verdict.reason === "malformed_body" || verdict.reason === "missing_headers"
          ? 400
          : 401;
    return { status, body: "refused" };
  }
  const { eventType, eventKey } = verdict.event;
  const event = verdict.event.payload as { resource?: Record<string, unknown> };
  const res = event.resource ?? {};

  const sale = SALE_EVENTS[eventType];
  if (sale) {
    const amount = res["amount"] as { total?: unknown; currency?: unknown } | undefined;
    const paymentId = text(res["id"], 64);
    const subscriptionId = text(res["billing_agreement_id"]) ?? "";
    const saleId = text(res["sale_id"], 64) ?? "";
    const currency = text(amount?.currency, 3);
    if (!paymentId || !currency || (sale === "COMPLETED" && !subscriptionId))
      return { status: 400, body: "refused" };
    await deps.recordSale({
      event: sale,
      subscriptionId,
      paymentId,
      saleId,
      amountCents: cents(amount?.total),
      currency,
    });
    return { status: 200, body: "ok" };
  }
  const subEvent = SUBSCRIPTION_EVENTS[eventType];
  if (subEvent) {
    const subscriptionId = text(res["id"]);
    if (!subscriptionId) return { status: 400, body: "refused" };
    await deps.subscriptionEvent({ subscriptionId, event: subEvent, eventId: eventKey });
    return { status: 200, body: "ok" };
  }
  return { status: 200, body: "ok" }; // another subscription event we don't track
}
