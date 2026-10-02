/**
 * Pure helpers for the member account. No I/O and no server imports, so both the server data layer
 * and the browser can use them and they can be unit-tested directly.
 *
 * NOTHING here decides money or points: the database does. These helpers only translate its
 * results into display values (and a best-effort preview that the server re-checks).
 */

export const ORDER_STATUS_LABELS: Record<string, string> = {
  awaiting_payment: "Awaiting payment",
  confirmed: "Confirmed",
  packing: "Being packed",
  ready: "Ready",
  out_for_delivery: "Out for delivery",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const statusLabel = (status: string) =>
  ORDER_STATUS_LABELS[status] ?? status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export type LoyaltyRules = {
  earnRandPerPoint: number;
  redeemRandPerPoint: number;
  minRedeemPoints: number;
  maxRedeemPct: number;
};

export type LoyaltyTier = {
  code: string;
  name: string;
  min_lifetime_points: number;
  perks: string[];
};

export const DEFAULT_RULES: LoyaltyRules = {
  earnRandPerPoint: 10,
  redeemRandPerPoint: 0.1,
  minRedeemPoints: 100,
  maxRedeemPct: 50,
};

export function rulesFromRows(rows: { code: string; value: number | string }[]): LoyaltyRules {
  const v = (code: string, fallback: number) => {
    const row = rows.find((r) => r.code === code);
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    earnRandPerPoint: v("earn_rand_per_point", DEFAULT_RULES.earnRandPerPoint),
    redeemRandPerPoint: v("redeem_rand_per_point", DEFAULT_RULES.redeemRandPerPoint),
    minRedeemPoints: v("redeem_min_points", DEFAULT_RULES.minRedeemPoints),
    maxRedeemPct: v("redeem_max_pct_of_order", DEFAULT_RULES.maxRedeemPct),
  };
}

/** Tier progress from LIFETIME points (spending points never lowers a tier). */
export function tierProgress(lifetime: number, tiers: LoyaltyTier[]) {
  const sorted = [...tiers].sort((a, b) => a.min_lifetime_points - b.min_lifetime_points);
  const current = [...sorted].reverse().find((t) => t.min_lifetime_points <= lifetime) ?? null;
  const next = sorted.find((t) => t.min_lifetime_points > lifetime) ?? null;
  const floor = current?.min_lifetime_points ?? 0;
  // `next.min > lifetime >= floor`, so the span is positive for any sane tier table; the guard keeps
  // a hand-edited table with duplicate minimums from producing NaN/Infinity in the UI.
  const span = next ? next.min_lifetime_points - floor : 0;
  const percent =
    next && span > 0 ? Math.min(100, Math.max(0, ((lifetime - floor) / span) * 100)) : 100;
  return {
    current,
    next,
    pointsToNext: next ? next.min_lifetime_points - lifetime : 0,
    percent: Math.round(percent),
  };
}

/**
 * Largest redemption the member could try on an order. DISPLAY ONLY: the redeem RPC re-computes
 * this from the live rules and the locked balance, and is the only thing that can apply points.
 */
export function maxRedeemablePoints(
  itemSubtotal: number,
  balance: number,
  rules: LoyaltyRules,
): number {
  const maxDiscount = Math.floor(itemSubtotal * rules.maxRedeemPct) / 100;
  const byOrder = Math.floor(maxDiscount / rules.redeemRandPerPoint + 1e-9);
  const allowed = Math.min(byOrder, Math.max(balance, 0));
  return allowed >= rules.minRedeemPoints ? allowed : 0;
}

export const pointsValueRand = (points: number, rules: LoyaltyRules) =>
  Math.round(points * rules.redeemRandPerPoint * 100) / 100;

export type ReorderLine = {
  product_id: string | null;
  name: string;
  quantity: number;
  previous_price: number;
  current_price: number | null;
  available: number;
  status: "ok" | "price_changed" | "insufficient_stock" | "unavailable";
};

export type ReorderCheck = {
  order_id: string;
  order_number: string;
  lines: ReorderLine[];
  orderable: boolean;
  /** Delivery fee re-priced at today's rate (0 for orders that had none). */
  delivery_fee?: number;
  current_total: number | null;
};

export function summariseReorder(check: ReorderCheck) {
  const blocked = check.lines.filter(
    (l) => l.status === "unavailable" || l.status === "insufficient_stock",
  );
  const repriced = check.lines.filter((l) => l.status === "price_changed");
  return {
    canReorder: check.orderable && check.current_total !== null,
    blocked,
    repriced,
    message: blocked.length
      ? `${blocked.map((l) => l.name).join(", ")} ${blocked.length === 1 ? "is" : "are"} no longer available in the quantity you ordered.`
      : repriced.length
        ? "Some prices have changed since your last order. Please review the new total."
        : null,
  };
}

const ERROR_MESSAGES: Record<string, string> = {
  address_not_found: "That address could not be found",
  address_limit: "You can save up to 10 addresses",
  invalid_address: "Please check the address details",
  order_not_found: "That order could not be found",
  order_not_redeemable: "Points can only be applied to an order that is awaiting payment",
  redemption_exists: "Points have already been applied to this order",
  below_minimum: "That is below the minimum redemption",
  exceeds_order_limit: "That is more than can be applied to this order",
  insufficient_points: "You do not have enough points",
  invalid_points: "Enter a whole number of points",
  idempotency_conflict:
    "This request was already submitted with different details — please refresh",
  expected_total_required: "Please confirm the current total before reordering",
  price_changed: "Prices changed while you were reviewing — please check the new total",
  reorder_unavailable: "Some items in this order are no longer available",
  insufficient_stock: "Some items are no longer in stock in that quantity",
  product_unavailable: "That product is no longer available",
  too_many_open_orders: "Please pay for or cancel an open order before placing another",
  wishlist_full: "Your saved list is full",
  product_in_stock: "This product is in stock right now",
  subscription_limit: "You can follow up to 50 products",
  invalid_delivery_method: "That delivery option is not available",
  delivery_unavailable: "That delivery option is no longer offered",
  checkout_unavailable: "Some items in your basket are no longer available",
  address_incomplete: "Please add a suburb or city to that address",
  invalid_contact: "Please enter your name and a valid phone number",
  payment_method_unsupported: "Choose EFT, card or PayPal",
  order_not_payable: "This order is no longer awaiting payment",
  invalid_items: "Your basket could not be read — please refresh it",
  verification_required: "Verify your ID before placing an order",
  verification_pending: "Your ID is being reviewed — you can order once it is approved",
  already_verified: "Your ID is already verified",
  underage: "You must be 18 or older to shop with CannaPlug",
  invalid_dob: "Enter your date of birth",
  invalid_document_type: "Choose the type of document you are uploading",
  invalid_document_path: "We could not read your upload — please upload your ID again",
  too_many_attempts: "Too many attempts — please contact CannaPlug support",
  forbidden: "You do not have permission for this action",
  self_review_forbidden: "Another manager must review your own ID",
  not_pending: "This ID is no longer waiting for review — refresh the list",
  rejection_reason_required: "Choose a rejection reason (and add a note for “Other”)",
  rejection_note_too_long: "Keep the note under 500 characters",
  invalid_decision: "Choose approve or reject",
  verification_not_found: "No ID submission was found for that member",
  verification_expired: "Your ID document has expired — upload a current one to keep ordering",
  invalid_expiry: "Enter the expiry date shown on your document",
  document_expired: "That document has expired — upload a current one",
};

/** Detail text after the code is user-safe for these (it carries numbers the member needs). */
const SHOW_DETAIL = new Set([
  "below_minimum",
  "exceeds_order_limit",
  "price_changed",
  "reorder_unavailable",
  "insufficient_stock",
  "checkout_unavailable",
  "delivery_unavailable",
]);

/**
 * An error whose message is already safe to show a member. friendlyMemberError passes these through
 * untouched, so translating twice (data layer, then server-function boundary) cannot degrade a specific
 * message ("You do not have enough points") into the generic fallback.
 */
export class MemberError extends Error {
  readonly memberFacing = true;
  constructor(message: string) {
    super(message);
    this.name = "MemberError";
  }
}

export function friendlyMemberError(err: unknown): Error {
  if (err instanceof MemberError) return err;
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
  const code = /^([a-z_]+)(?::|$)/.exec(raw)?.[1];
  if (code && ERROR_MESSAGES[code]) {
    const detail = raw.slice(code.length + 1).trim();
    return new MemberError(
      SHOW_DETAIL.has(code) && detail
        ? `${ERROR_MESSAGES[code]} (${detail})`
        : ERROR_MESSAGES[code]!,
    );
  }
  if (/duplicate key|already exists/i.test(raw)) return new MemberError("That is already saved");
  if (/row-level security|permission denied/i.test(raw))
    return new MemberError("You do not have permission for this action");
  return new MemberError("The action could not be completed. Please retry.");
}

const LOYALTY_SOURCE_LABELS: Record<string, string> = {
  order: "Earned on an online order",
  order_redeem: "Redeemed on an online order",
  order_redeem_release: "Points returned — order cancelled",
  order_cancel: "Points reversed — order cancelled",
  pos_sale: "Earned in store",
  pos_sale_void: "Points reversed — sale voided",
  pos_refund: "Points adjusted — refund",
};

export const describeLoyaltyTxn = (sourceType: string) =>
  LOYALTY_SOURCE_LABELS[sourceType] ?? "Points adjustment";
