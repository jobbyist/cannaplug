// Account closing, in one place (pure): what the member sees and what each choice does. The database decides; this is wording.

export type AccountAction = "deactivate" | "reactivate" | "request_deletion";
export type AccountStatus = "active" | "deactivated" | "deletion_requested" | "deleted";
export type AccountState = {
  status: AccountStatus;
  deactivated_at: string | null;
  deletion_requested_at: string | null;
  open_orders: number;
};

export const statusLabel = (s: AccountStatus | "active" | "deactivated" | "deletion_requested") =>
  s === "deactivated"
    ? "Deactivated"
    : s === "deletion_requested"
      ? "Deletion requested"
      : s === "deleted"
        ? "Deleted"
        : "Active";

/** What a member is told before they confirm. Kept short and specific. */
export const DEACTIVATE_EXPLAINER =
  "Deactivating pauses your account. You can't place orders and we stop marketing emails. Your points and order history are kept, and you can reactivate any time by signing in.";
export const DELETE_EXPLAINER =
  "Deleting removes your name, phone, address, date of birth, ID details and saved items. Your account is deactivated straight away and our team completes the deletion. Points are lost. Records we must keep by law (orders, receipts and any medical documents) stay, without your name. You can cancel the request by reactivating before it is completed.";

/** A member with an order in progress must finish it first (the database refuses too). */
export const closeBlockedReason = (state: Pick<AccountState, "open_orders">): string | null =>
  state.open_orders > 0
    ? `You have ${state.open_orders} open order${state.open_orders === 1 ? "" : "s"}. Collect or cancel ${state.open_orders === 1 ? "it" : "them"} before closing your account.`
    : null;

/** Admin: the reason is written to the audit log (3 to 200 characters, same as the database). */
export const reasonProblem = (reason: string): string | null => {
  const r = reason.trim();
  if (r.length < 3) return "Write a short reason (for example: asked by WhatsApp on 27 Nov).";
  if (r.length > 200) return "Keep the reason under 200 characters.";
  return null;
};
