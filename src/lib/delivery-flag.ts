/**
 * Delivery switch. Online orders are in-store pickup only until the client approves delivery.
 * To switch delivery on later: set DELIVERY_ENABLED=true in Vercel and redeploy. Anything else keeps it off.
 * The check is on the server (listing, quoting and placing an order), so a browser cannot ask for delivery.
 */
export const deliveryEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env["DELIVERY_ENABLED"] ?? "").trim().toLowerCase() === "true";

export const DELIVERY_PAUSED_MESSAGE =
  "Delivery is coming soon. For now, orders are collected in store.";
