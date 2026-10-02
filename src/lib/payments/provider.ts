/**
 * Payment provider interface.
 *
 * A provider does exactly three things: create a hosted checkout for a transaction whose amount was
 * already fixed by the database, verify an inbound webhook, and (PayPal only) capture/look up an order
 * server-side. It never decides that an order is paid — it only produces `VerifiedFacts`, which the
 * database compares against the stored expectation (`payments_apply_verified_event`).
 */
export type ProviderId = "yoco" | "paypal";
export type Mode = "test" | "live";

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** What the database needs to compare. Produced ONLY from a verified webhook or a direct provider API response. */
export interface VerifiedFacts {
  kind: "payment_succeeded" | "payment_failed" | "payment_refunded" | "ignored";
  transaction_id: string | null;
  provider_ref: string | null;
  provider_payment_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  mode: Mode | null;
  merchant_id: string | null;
  reason?: string;
}

export interface VerifiedEvent {
  /** Unique per provider delivery/event: the replay key. */
  eventKey: string;
  eventType: string;
  /** Stored for audit. Contains no card data (providers never send any). */
  payload: unknown;
  facts: VerifiedFacts;
}

export type VerifyOutcome =
  | { ok: true; event: VerifiedEvent }
  | { ok: false; reason: RejectReason };

export type RejectReason =
  | "missing_headers"
  | "bad_timestamp"
  | "stale_timestamp"
  | "invalid_signature"
  | "malformed_body"
  | "verification_failed"
  | "verification_unavailable"
  | "not_configured";

export interface CheckoutRequest {
  transactionId: string;
  orderNumber: string;
  /** Exactly the amount/currency stored on the transaction. */
  amount: number;
  currency: "ZAR" | "USD";
  successUrl: string;
  cancelUrl: string;
  failureUrl: string;
}

export interface CheckoutSession {
  providerRef: string;
  redirectUrl: string;
}

export interface PaymentProvider {
  id: ProviderId;
  mode: Mode;
  /** Merchant identifier stored on the transaction and compared with the verified event. */
  merchantId: string | null;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  verifyWebhook(raw: string, headers: Headers): Promise<VerifyOutcome>;
}

export const toMinor = (value: number | string): number => Math.round(Number(value) * 100);

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
