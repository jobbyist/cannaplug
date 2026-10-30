// Plain-language errors for staff screens (admin, POS, payments, receipts, products, clinical, ID checks).
// Pure: the middleware that applies it to every staff server function lives in staff-errors.middleware.ts.
//
// Three kinds of error reach a server function's caller:
//  1. Messages the app wrote for people ("That SKU is already used by another product.") → passed through.
//  2. Database exceptions in our `code: detail` convention ("insufficient_stock: …") → mapped to a sentence.
//  3. Anything raw (SQL, PostgREST, network, validation dumps, programming errors) → a generic sentence.
// Raw text never reaches the screen; the original is logged on the server by the middleware.

export const STAFF_ERROR_MESSAGES: Record<string, string> = {
  forbidden: "Your role can't do this. Ask a manager.",
  // POS
  insufficient_stock: "Not enough stock available",
  tender_mismatch: "Tenders must add up exactly to the sale total",
  session_closed: "This till session is closed",
  session_not_yours: "This till session belongs to another cashier",
  session_not_found: "Till session not found",
  drawer_already_open: "That drawer already has an open session",
  drawer_unavailable: "That drawer is not available",
  drawer_not_found: "That drawer could not be found",
  sale_not_found: "That sale could not be found",
  sale_total_mismatch: "The sale total changed. Refresh and try again",
  payment_reference_in_use: "That payment reference was already used on another payment",
  product_unavailable: "A product in the basket is no longer available",
  over_refund: "Refund exceeds what was sold or tendered",
  refund_mismatch: "Refund payouts must add up to the refund total",
  invalid_sale_state: "This sale can no longer be changed that way",
  reason_required: "A reason is required",
  invalid_tenders: "Check the payment details",
  invalid_items: "Check the basket",
  invalid_batch_size: "Outdoor flower is sold in batches of 5 g",
  insufficient_tubes: "The member needs 10 returned tubes for a free pre-roll",
  reward_needs_member: "Attach the member to use a reward",
  reward_not_eligible: "That product is not covered by the reward",
  reward_unavailable: "That reward is not available",
  insufficient_points: "The member does not have enough points for that reward",
  invalid_amount: "Check the amount",
  invalid_quantity: "Check the quantity",
  not_pending: "Nothing is waiting for a decision there. Refresh the list",
  self_review_forbidden: "Another manager must approve this",
  stock_mismatch: "Stock changed while you were working. Refresh and try again",
  batch_not_found: "That batch could not be found",
  invalid_batch_code: "Check the batch code",
  invalid_unit_cost: "Check the unit cost",
  invalid_received_date: "Check the received date",
  // Orders and payments
  order_not_found: "That order could not be found",
  invalid_transition: "That status change is not allowed from the order's current status",
  invalid_order_state: "That order can no longer be changed that way",
  transaction_not_found: "That payment could not be found",
  bank_reference_in_use: "That bank reference was already used",
  invalid_bank_reference: "Check the bank reference",
  dual_control_required: "A second manager must approve this payment",
  confirmation_required: "Tick the confirmation box first",
  eft_details_unconfirmed: "The owner must confirm the bank details first",
  invalid_eft_details: "Check the bank details",
  invalid_branch_code: "The branch code must be 6 digits",
  invalid_account_number: "Check the account number",
  invalid_account_holder: "Check the account holder",
  invalid_account_type: "Check the account type",
  invalid_bank: "Check the bank name",
  invalid_rate: "Check the exchange rate",
  fx_rate_unavailable:
    "The exchange rate is not available right now. Set a manual rate or try later",
  payment_confirmation_required: "Confirm the payment first",
  // ID checks and members
  verification_not_found: "No ID submission was found for that member",
  rejection_reason_required: "Choose a rejection reason (and add a note for “Other”)",
  rejection_note_too_long: "Keep the note under 500 characters",
  invalid_decision: "Choose approve or reject",
  member_not_found: "That member could not be found",
  username_taken: "That username is taken. Try another.",
  username_invalid: "A username is 3 to 20 letters, numbers or underscores.",
  username_reserved: "That username is not available. Try another.",
  username_unchanged: "That is already their username",
  customer_not_found: "That customer could not be found",
  user_not_found: "That person could not be found",
  notification_not_found: "That notification could not be found",
  alert_readonly: "Automatic alerts update themselves and can't be edited",
  order_paid: "A paid order can't be archived",
  // Products and imports
  duplicate_sku_in_file: "The file repeats a SKU",
  barcode_in_use: "That barcode is already used by another product",
  invalid_rows: "Some rows in the file are not valid",
  purchase_limit_exceeded: "This customer has reached today's purchase limit",
  not_locked: "This member is not locked out",
  pickup_order:
    "This order is collected in store. Mark it Completed when the customer collects it.",
  // General
  idempotency_conflict: "This was already submitted with different details. Refresh and try again",
  idempotency_key_required: "Refresh the page and try again",
  invalid_input: "Some details are missing or not valid",
  rate_limited: "Too many attempts. Wait a minute and try again",
  too_many_requests: "Too many attempts. Wait a minute and try again",
  isolation_level: "The server is misconfigured. Contact support",
};

/** Detail after the code carries numbers or names staff need (never SQL). */
const SHOW_DETAIL = new Set([
  "insufficient_stock",
  "tender_mismatch",
  "over_refund",
  "refund_mismatch",
  "invalid_sale_state",
  "barcode_in_use",
  "purchase_limit_exceeded",
]);

export const GENERIC_STAFF_ERROR = "That didn't work and nothing was changed. Please try again.";
const SESSION_EXPIRED = "Your session has expired. Sign in again.";

/** Text that only a database, a library or a bug would produce. */
const RAW =
  /violates|relation "|column "|does not exist|syntax error|duplicate key|permission denied|row-level security|\bJWT\b|PGRST|invalid input syntax|null value in|foreign key|ECONN|ENOTFOUND|fetch failed|Unexpected token|Cannot read propert|is not a function|is not defined|undefined|SQLSTATE|supabase|postgres|\bat .+\.(ts|js):\d+|"code":|"path":|TypeError|ReferenceError|RangeError|SyntaxError/i;

export class StaffError extends Error {
  readonly friendly = true;
}

function messageOf(err: unknown): { text: string; pgCode?: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { text: err.message, ...(typeof code === "string" ? { pgCode: code } : {}) };
  }
  if (typeof err === "object" && err) {
    const o = err as { message?: unknown; code?: unknown };
    return {
      text: typeof o.message === "string" ? o.message : "",
      ...(typeof o.code === "string" ? { pgCode: o.code } : {}),
    };
  }
  return { text: typeof err === "string" ? err : "" };
}

export function friendlyStaffError(err: unknown): Error {
  if (err instanceof StaffError) return err;
  const { text, pgCode } = messageOf(err);
  const raw = text.trim();

  // 2. our database convention: `code` or `code: detail`
  const code = /^([a-z][a-z0-9_]*)(?::|$)/.exec(raw)?.[1];
  if (code) {
    const msg = STAFF_ERROR_MESSAGES[code];
    if (!msg) return new StaffError(GENERIC_STAFF_ERROR);
    const detail = raw.slice(code.length + 1).trim();
    return new StaffError(
      SHOW_DETAIL.has(code) && detail && !RAW.test(detail)
        ? `${msg} (${detail.slice(0, 120)})`
        : msg,
    );
  }

  // 3. raw: decide by Postgres error code first, then by the text
  if (pgCode === "42501" || /^forbidden\b/i.test(raw))
    return new StaffError(STAFF_ERROR_MESSAGES["forbidden"]!);
  if (/^unauthori[sz]ed\b|not authenticated|session.*expired|invalid.*token/i.test(raw))
    return new StaffError(SESSION_EXPIRED);
  if (pgCode === "23505" || /duplicate key/i.test(raw))
    return new StaffError("That is already saved (a value that must be unique is already used)");
  if (pgCode === "23514" || pgCode === "22P02" || pgCode === "23502")
    return new StaffError("One of the values is not allowed. Check the form and try again");
  if (/^\s*\[\s*\{/.test(raw) || /"code":/.test(raw))
    return new StaffError(STAFF_ERROR_MESSAGES["invalid_input"]!);
  if (!raw || RAW.test(raw) || !(err instanceof Error) || raw.length > 300)
    return new StaffError(GENERIC_STAFF_ERROR);

  // 1. a message the app wrote for people
  return new StaffError(raw);
}
