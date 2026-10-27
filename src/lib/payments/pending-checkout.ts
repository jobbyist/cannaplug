/**
 * Remembers, for this browser tab only, which order is waiting for an online payment, so a refresh or an
 * interrupted payment window brings the member back to the same order instead of an empty cart. It holds
 * ids and the order number only, and is never trusted: the page re-reads the order from the server (scoped
 * to the signed-in member) before showing anything, and drops the note once the order is paid or gone.
 */
const KEY = "cannaplug.checkout.pending";

export type PendingCheckout = {
  orderId: string;
  orderNumber: string;
  method: "card" | "paypal";
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function savePendingCheckout(p: PendingCheckout): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode or storage blocked: resuming is a convenience only */
  }
}

export function loadPendingCheckout(): PendingCheckout | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Partial<PendingCheckout> | null;
    if (
      v &&
      typeof v.orderId === "string" &&
      UUID.test(v.orderId) &&
      typeof v.orderNumber === "string" &&
      v.orderNumber.length <= 40 &&
      (v.method === "card" || v.method === "paypal")
    )
      return { orderId: v.orderId, orderNumber: v.orderNumber, method: v.method };
  } catch {
    /* unreadable: treat as nothing pending */
  }
  return null;
}

export function clearPendingCheckout(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
