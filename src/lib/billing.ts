/** Shared (browser + server) types and copy for the admin Billing tab. */
export type BillingStatus = "active" | "paused" | "cancelled" | "pending";
export type BillingPaymentKind = "link" | "payfast_form" | "manage" | "none";
export type BillingRecurKind = "every_days" | "monthly" | "yearly";

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
  recur_kind: BillingRecurKind | null;
  recur_n: number | null;
  anchor_date: string | null;
  updated_at: string;
}

export interface BillingPaymentRow {
  id: string;
  account_id: string;
  provider: string;
  currency: string;
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

export const DOMAIN_MANAGE_MESSAGE =
  "Your domain is still active. Contact your developer if you wish to extend your domain registration term, register a new domain or cancel/delete your domain.";

/** Payment statuses that mean the money arrived (Payfast says COMPLETE, PayPal says COMPLETED). */
export const isPaidStatus = (status: string) => status === "COMPLETE" || status === "COMPLETED";

/** "R180.00" or "$25.00" from a stored amount. */
export function formatMoney(cents: number | null, currency: string): string {
  if (cents == null) return "";
  const symbol = currency === "USD" ? "$" : currency === "ZAR" ? "R" : `${currency} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

/** Today's date in South Africa (SAST, no daylight saving), as YYYY-MM-DD. */
export function todaySast(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(now);
}

const DAY_MS = 86_400_000;
const utc = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

/**
 * The next date on or after `today` that the billing rule lands on. Mirrors the database function billing_next_due:
 * every N days from the anchor, monthly or yearly on the anchor's day (clamped to a short month's last day).
 */
export function nextBillingDate(
  rule: { recur_kind: BillingRecurKind | null; recur_n: number | null; anchor_date: string | null },
  today: string,
): string | null {
  const { recur_kind: kind, recur_n: n, anchor_date: anchor } = rule;
  if (!kind || !anchor) return null;
  if (kind === "every_days") {
    if (!n || n < 1) return null;
    const a = utc(anchor);
    const t = utc(today);
    if (a >= t) return anchor;
    return iso(a + Math.ceil((t - a) / DAY_MS / n) * n * DAY_MS);
  }
  const base = Math.max(utc(today), utc(anchor));
  let y = new Date(base).getUTCFullYear();
  const day = Number(anchor.slice(8, 10));
  if (kind === "monthly") {
    let m = new Date(base).getUTCMonth() + 1;
    for (;;) {
      const c = Date.UTC(y, m - 1, Math.min(day, lastDay(y, m)));
      if (c >= base) return iso(c);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }
  const month = Number(anchor.slice(5, 7));
  for (;;) {
    const c = Date.UTC(y, month - 1, Math.min(day, lastDay(y, month)));
    if (c >= base) return iso(c);
    y += 1;
  }
}

/** Whole days from `today` to `date` (both YYYY-MM-DD). */
export const daysUntil = (date: string, today: string) =>
  Math.round((utc(date) - utc(today)) / DAY_MS);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "30 Oct 2026" */
export const formatDay = (isoDate: string) =>
  `${Number(isoDate.slice(8, 10))} ${MONTHS[Number(isoDate.slice(5, 7)) - 1]} ${isoDate.slice(0, 4)}`;

export const dueLabel = (days: number) =>
  days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
