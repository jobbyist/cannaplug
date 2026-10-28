/** Shared (browser + server) types and copy for the admin Billing tab. */
export type BillingStatus = "active" | "paused" | "cancelled" | "pending";
export type BillingPaymentKind = "link" | "payfast_form" | "none";

export interface BillingAccount {
  id: string;
  slug: string;
  position: number;
  name: string;
  provider: string;
  beneficiary: string;
  amount_text: string;
  schedule_text: string;
  status: BillingStatus;
  payment_kind: BillingPaymentKind;
  payment_url: string | null;
  payment_note: string;
  status_reason: string | null;
  updated_at: string;
}

export interface BillingPaymentRow {
  id: string;
  account_id: string;
  status: string;
  amount_cents: number | null;
  created_at: string;
}

export const DEACTIVATE_WARNING =
  "Deactivating this service could lead to platform functionality errors and backend service disruption. Contact your developer or account manager for confirmation before you deactivate any services.";

/** Payfast "Pay Now" button settings for the ID Verification (VerifyNow) credits. */
export const VERIFYNOW_PAYFAST = {
  action: "https://payment.payfast.io/eng/process",
  receiver: "25538645",
  returnUrl: "https://cannaplug012.co.za/billing/verifynow/return",
  cancelUrl: "https://cannaplug012.co.za/billing/verifynow/cancel",
  notifyUrl: "https://cannaplug012.co.za/billing/verifynow/notify",
  itemName: "Real-Time ID Verification API Credits",
  itemDescription:
    "Basic ID and passport number with free photo or document submission support and manual reviews. Includes user anonymization. Custom API integrated with VerifyNow. 500MB storage limit.",
  buttonImage: "https://my.payfast.io/images/buttons/PayNow/Light-Large-PayNow.png",
  minAmount: "5.00",
  defaultAmount: "100",
} as const;

/** Which billing account each Payfast notify route belongs to. */
export const BILLING_NOTIFY_SLUG = {
  payfast: "payfast-gateway",
  verifynow: "verifynow-id",
} as const;
export type BillingService = keyof typeof BILLING_NOTIFY_SLUG;

export const BILLING_SERVICE_LABEL: Record<BillingService, string> = {
  payfast: "Payfast",
  verifynow: "VerifyNow",
};
