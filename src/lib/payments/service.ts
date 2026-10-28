import type {
  CheckoutRequest,
  Mode,
  OnsiteSession,
  PaymentProvider,
  ProviderId,
  RejectReason,
  VerifiedEvent,
  VerifiedFacts,
} from "./provider";
import type { PayPalProvider } from "./paypal";

/**
 * Payment orchestration, free of any framework/DB client so it can be exercised against a real database
 * and mock provider servers in tests. All money decisions are delegated to the database
 * (`payment_initiate`, `payments_apply_verified_event`); this layer only moves facts between them.
 */
export interface TxView {
  id: string;
  order_id: string;
  provider: ProviderId;
  status: string;
  expected_amount: number;
  expected_currency: "ZAR" | "USD";
  fx_rate: number | null;
  provider_ref: string | null;
  redirect_url: string | null;
}

export interface InitiateResult {
  transaction_id: string;
  order_number: string;
  reused: boolean;
}

export interface PaymentsDb {
  initiate(a: {
    userId: string;
    orderId: string;
    provider: ProviderId;
    mode: Mode;
    merchantId: string | null;
    key: string;
  }): Promise<InitiateResult>;
  getTx(id: string): Promise<TxView | null>;
  findPayPalTx(userId: string, providerRef: string): Promise<TxView | null>;
  attach(txId: string, providerRef: string, redirectUrl: string): Promise<void>;
  markFailed(txId: string, reason: string): Promise<void>;
  apply(
    provider: ProviderId,
    e: { eventKey: string; eventType: string; payload: unknown; facts: VerifiedFacts },
  ): Promise<{ status: string; outcome: string; replayed: boolean }>;
  reject(
    provider: ProviderId,
    reason: RejectReason,
    ipHash: string | null,
    hint: string | null,
  ): Promise<void>;
}

export interface PaymentsDeps {
  db: PaymentsDb;
  providers: Partial<Record<ProviderId, PaymentProvider>>;
  /** Refreshes the PayPal ZAR→USD rate before initiation. */
  ensureFx(): Promise<unknown>;
  siteUrl: string;
  warn?(msg: string, err?: unknown): void;
}

export class PaymentError extends Error {
  constructor(
    readonly code:
      | "payment_provider_unavailable"
      | "payment_provider_error"
      | "payment_not_found"
      | "fx_rate_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

export interface StartedPayment {
  transactionId: string;
  provider: ProviderId;
  redirectUrl: string;
  amount: number;
  currency: "ZAR" | "USD";
  fxRate: number | null;
  /**
   * Set when the provider's own payment window can open on our checkout page (PayFast onsite). The hosted
   * `redirectUrl` is always prepared as well, so the page can fall back to it if the window cannot load.
   */
  onsite: OnsiteSession | null;
}

export async function startPayment(
  deps: PaymentsDeps,
  a: {
    userId: string;
    orderId: string;
    provider: ProviderId;
    key: string;
    /** From the verified session; PayFast onsite requires it. */
    buyerEmail?: string | null;
  },
): Promise<StartedPayment> {
  const provider = deps.providers[a.provider];
  if (!provider)
    throw new PaymentError(
      "payment_provider_unavailable",
      "This payment method is not available right now.",
    );

  if (a.provider === "paypal") {
    try {
      await deps.ensureFx();
    } catch (err) {
      deps.warn?.("fx unavailable", err);
      throw new PaymentError(
        "fx_rate_unavailable",
        "PayPal is temporarily unavailable. Please pay by card, Instant EFT or bank transfer.",
      );
    }
  }

  const init = await deps.db.initiate({
    userId: a.userId,
    orderId: a.orderId,
    provider: a.provider,
    mode: provider.mode,
    merchantId: provider.merchantId,
    key: a.key,
  });
  // Re-read: an idempotent replay returns the response cached at first initiation.
  const tx = await deps.db.getTx(init.transaction_id);
  if (!tx) throw new PaymentError("payment_not_found", "Payment not found.");

  const site = deps.siteUrl.replace(/\/+$/, "");
  const ret = `${site}/payment/return?order=${encodeURIComponent(a.orderId)}&provider=${a.provider}`;
  const checkout: CheckoutRequest = {
    transactionId: tx.id,
    orderNumber: init.order_number,
    amount: Number(tx.expected_amount),
    currency: tx.expected_currency,
    successUrl: `${ret}&result=success`,
    cancelUrl: `${ret}&result=cancelled`,
    failureUrl: `${ret}&result=failed`,
    notifyUrl: `${site}/api/public/payments/payfast-itn`,
  };

  // The onsite window is an optional upgrade: it can fail without failing the payment, because the hosted
  // page for the very same transaction is always ready. Both carry the same m_payment_id, amount and
  // notify URL, so whichever the member uses settles through the same verified ITN.
  const onsite = async (): Promise<OnsiteSession | null> => {
    if (!provider.onsite || !provider.createOnsitePayment) return null;
    try {
      return await provider.createOnsitePayment(checkout, { email: a.buyerEmail ?? null });
    } catch (err) {
      deps.warn?.("onsite payment unavailable, using the hosted page", err);
      return null;
    }
  };
  const started = async (url: string): Promise<StartedPayment> => ({
    transactionId: tx.id,
    provider: a.provider,
    redirectUrl: url,
    amount: Number(tx.expected_amount),
    currency: tx.expected_currency,
    fxRate: tx.fx_rate === null ? null : Number(tx.fx_rate),
    onsite: await onsite(),
  });
  if (tx.provider_ref && tx.redirect_url && tx.status === "pending")
    return started(tx.redirect_url);

  let session: Awaited<ReturnType<PaymentProvider["createCheckout"]>>;
  try {
    session = await provider.createCheckout(checkout);
    await deps.db.attach(tx.id, session.providerRef, session.redirectUrl);
  } catch (err) {
    deps.warn?.("provider checkout failed", err);
    await deps.db.markFailed(tx.id, "provider_checkout_failed").catch(() => undefined);
    throw new PaymentError(
      "payment_provider_error",
      "We could not start that payment. Please try again or choose another method.",
    );
  }
  return started(session.redirectUrl);
}

export type WebhookResult = { status: 200 | 400 | 401 | 413 | 503; body: string };
const MAX_WEBHOOK_BYTES = 100_000;

/**
 * Verify first; only a verified event reaches business logic. Invalid messages are logged (no payload)
 * and refused. A verification outage answers 503 so the provider retries.
 */
export async function handleWebhook(
  deps: PaymentsDeps,
  providerId: ProviderId,
  raw: string,
  headers: Headers,
  ipHash: string | null,
  sourceIp: string | null = null,
): Promise<WebhookResult> {
  const provider = deps.providers[providerId];
  if (!provider) return { status: 503, body: "not configured" };
  if (raw.length > MAX_WEBHOOK_BYTES) {
    await deps.db.reject(providerId, "malformed_body", ipHash, null).catch(() => undefined);
    return { status: 413, body: "payload too large" };
  }
  const v = await provider.verifyWebhook(raw, headers, { sourceIp });
  if (!v.ok) {
    await deps.db
      .reject(providerId, v.reason, ipHash, headers.get("paypal-transmission-id"))
      .catch(() => undefined);
    if (v.reason === "verification_unavailable") return { status: 503, body: "try again" };
    return { status: v.reason === "malformed_body" ? 400 : 401, body: "rejected" };
  }
  // A database failure must surface as 5xx so the provider redelivers; replays are harmless by design.
  await deps.db.apply(providerId, v.event);
  return { status: 200, body: "ok" };
}

export type ReturnStatus = "paid" | "pending" | "failed" | "not_found";

/**
 * Member returns from PayPal. The token in the URL is only a lookup key: the capture is performed and
 * read server-side with our credentials, and its facts go through the same verified path as a webhook.
 */
export async function confirmPayPalReturn(
  deps: PaymentsDeps,
  userId: string,
  orderToken: string,
): Promise<ReturnStatus> {
  const provider = deps.providers.paypal as PayPalProvider | undefined;
  if (!provider) return "not_found";
  const tx = await deps.db.findPayPalTx(userId, orderToken);
  if (!tx) return "not_found";
  if (tx.status === "succeeded") return "paid";
  const cap = await provider.captureOrder(orderToken, tx.id);
  const r = await deps.db.apply("paypal", {
    eventKey: cap.eventKey,
    eventType: "api.order.capture",
    payload: cap.payload,
    facts: cap.facts,
  });
  if (r.outcome === "confirmed" || r.outcome === "already_processed") return "paid";
  return cap.facts.kind === "payment_failed" ? "failed" : "pending";
}

export type { VerifiedEvent };
