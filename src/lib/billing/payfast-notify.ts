import {
  createPayFastProvider,
  type PayFastConfig,
  type ResolveHost,
} from "@/lib/payments/payfast";
import type { FetchLike } from "@/lib/payments/provider";
import { BILLING_NOTIFY_SLUG, type BillingService } from "@/lib/billing";

/** Cannaplug pays these services to a Payfast merchant managed by the developer, not to its own shop merchant. */
export const DEFAULT_BILLING_MERCHANT = "25538645";

/** The receiving merchant's settings. Null (notifications refused) when the passphrase is not set. */
export function billingPayfastFromEnv(
  env: Record<string, string | undefined>,
): PayFastConfig | null {
  const merchantId = env["BILLING_PAYFAST_MERCHANT_ID"]?.trim() || DEFAULT_BILLING_MERCHANT;
  const passphrase = env["BILLING_PAYFAST_PASSPHRASE"]?.trim();
  const name = (env["BILLING_PAYFAST_ENV"] ?? "").trim().toLowerCase();
  if (!passphrase || !/^[0-9]{5,12}$/.test(merchantId)) return null;
  if (name !== "" && name !== "live" && name !== "sandbox") return null;
  return { merchantId, merchantKey: "", passphrase, sandbox: name === "sandbox" };
}

export interface BillingNotifyDeps {
  cfg: PayFastConfig | null;
  fetchFn: FetchLike;
  /** Tests only: how Payfast's server names resolve. */
  resolveHost?: ResolveHost;
  recordPayment(a: {
    slug: string;
    paymentId: string;
    status: string;
    amountCents: number | null;
    itemName: string | null;
  }): Promise<{ recorded: boolean }>;
}

/**
 * A Payfast notification for a service payment. It goes through the same security checks as shop payments
 * (signature, Payfast source address, Payfast's own validate call) before anything is stored. Only then is the
 * payment logged against the service's billing account, once per Payfast payment id and status. The amount
 * is not compared with an expected value because the Pay Now button lets the admin choose it.
 */
export async function handleBillingNotify(
  deps: BillingNotifyDeps,
  service: BillingService,
  raw: string,
  headers: Headers,
  sourceIp: string | null,
): Promise<{ status: number; body: string }> {
  if (!deps.cfg) return { status: 503, body: "unavailable" };
  const provider = createPayFastProvider(deps.cfg, deps.fetchFn, deps.resolveHost);
  const verdict = await provider.verifyWebhook(raw, headers, { sourceIp });
  if (!verdict.ok) {
    const status =
      verdict.reason === "verification_unavailable"
        ? 503
        : verdict.reason === "malformed_body"
          ? 400
          : 401;
    return { status, body: "refused" };
  }
  const { event } = verdict;
  if (event.facts.merchant_id !== deps.cfg.merchantId) return { status: 400, body: "refused" };
  const payload = event.payload as Record<string, string>;
  const paymentId = event.facts.provider_payment_id;
  const status = payload["payment_status"];
  if (!paymentId || !status) return { status: 400, body: "refused" };
  await deps.recordPayment({
    slug: BILLING_NOTIFY_SLUG[service],
    paymentId,
    status,
    amountCents: event.facts.amount_minor,
    itemName: payload["item_name"] ?? null,
  });
  return { status: 200, body: "ok" };
}
