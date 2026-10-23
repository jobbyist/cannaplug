/**
 * Push payloads: a title, a short neutral body and a same-site URL — nothing else. Lock screens are public, so a
 * push never carries product or order-item names, amounts, ID or health details, or anything a member typed.
 * The only variable text is an order number (validated) and, for the opt-in Journal topic, an article title.
 */
export type PushMessage = { title: string; body: string; url: string; tag: string };

const orderNo = (d: Record<string, unknown>) => {
  const n = d["order_number"];
  return typeof n === "string" && /^[A-Z]{2,4}-[0-9-]{4,16}$/.test(n) ? n : null;
};
const slug = (d: Record<string, unknown>) => {
  const s = d["slug"];
  return typeof s === "string" && /^[a-z0-9-]{1,120}$/.test(s) ? s : null;
};
/** Printable text only: control characters and angle brackets are dropped. */
const clean = (s: string, max: number) =>
  [...s]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch !== "<" && ch !== ">")
    .join("")
    .trim()
    .slice(0, max);

type Build = (d: Record<string, unknown>) => Omit<PushMessage, "tag"> | null;
const order =
  (title: string, body: (n: string) => string, fallback: string): Build =>
  (d) => {
    const n = orderNo(d);
    return { title, body: n ? body(n) : fallback, url: "/account" };
  };
const account: Build = () => ({
  title: "Account update",
  body: "There's an update in your CannaPlug account.",
  url: "/account",
});
const staff =
  (title: string, body: string): Build =>
  () => ({ title, body, url: "/admin" });

export const PUSH_MESSAGES: Record<string, Build> = {
  order_received: order(
    "Order received",
    (n) => `We've got order ${n}. Pay to confirm it.`,
    "We've got your order.",
  ),
  order_confirmed: order(
    "Order confirmed",
    (n) => `Order ${n} is paid and being prepared.`,
    "Your order is paid and being prepared.",
  ),
  order_ready: order("Ready for you", (n) => `Order ${n} is ready.`, "Your order is ready."),
  order_out_for_delivery: order(
    "On its way",
    (n) => `Order ${n} is out for delivery.`,
    "Your order is out for delivery.",
  ),
  order_completed: order(
    "Order complete",
    (n) => `Thanks — order ${n} is complete.`,
    "Thanks — your order is complete.",
  ),
  order_cancelled: order(
    "Order cancelled",
    (n) => `Order ${n} was cancelled.`,
    "Your order was cancelled.",
  ),
  id_approved: account,
  id_rejected: account,
  id_expiring: account,
  document_ready: account,
  back_in_stock: () => ({
    title: "Back in stock",
    body: "Something on your list is back. Have a look.",
    url: "/shop",
  }),
  journal_new: (d) => {
    const t = typeof d["title"] === "string" ? clean(d["title"], 90) : "";
    const s = slug(d);
    return {
      title: "New on the Journal",
      body: t || "A new article is up.",
      url: s ? `/journal/${s}` : "/journal",
    };
  },
  journal_digest: () => ({
    title: "This week on the Journal",
    body: "Fresh reading from CannaPlug.",
    url: "/journal",
  }),
  promo_announcement: () => ({
    title: "CannaPlug",
    body: "New offers are on. Take a look.",
    url: "/shop",
  }),
  staff_new_order: (d) => {
    const n = orderNo(d);
    return {
      title: "New order",
      body: n ? `Order ${n} is waiting.` : "A new order is waiting.",
      url: "/admin",
    };
  },
  staff_low_stock: staff("Low stock", "Some products are running low."),
  staff_payment_review: staff("Payment needs a look", "A payment is waiting for review."),
  staff_refund_needed: staff("Refund needed", "A payment needs a refund decision."),
  staff_eft_approval: staff("EFT to approve", "An EFT is waiting for a second approval."),
  staff_id_review: staff("ID to review", "A member's ID is waiting for review."),
  push_test: () => ({
    title: "CannaPlug",
    body: "Test notification — push works on this device.",
    url: "/account",
  }),
};

export function pushMessage(
  template: string,
  data: Record<string, unknown>,
  notificationId: string,
): PushMessage | null {
  const build = PUSH_MESSAGES[template];
  const m = build?.(data ?? {});
  if (!m) return null;
  return { ...m, tag: `${template}:${notificationId}`.slice(0, 80) };
}
