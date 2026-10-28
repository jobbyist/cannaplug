import type { AdminOrderStatus } from "@/lib/admin-data.server";

const transitions: Record<AdminOrderStatus, AdminOrderStatus[]> = {
  awaiting_payment: ["cancelled"], // confirmation only comes from a verified payment
  confirmed: ["packing", "cancelled"],
  packing: ["ready"],
  ready: ["out_for_delivery"],
  out_for_delivery: ["completed"],
  completed: [],
  cancelled: [],
};
/** In-store pickup orders go ready -> completed (collected); the database enforces the same rule. */
export const isPickup = (method: string | null | undefined) => method === "collection";
export function nextStatuses(
  status: string,
  method: string | null | undefined,
): AdminOrderStatus[] {
  if (isPickup(method) && status === "ready") return ["completed"];
  return (transitions[status as AdminOrderStatus] ?? []).filter(
    (s) => !(status === "awaiting_payment" && s === "confirmed"),
  );
}
export const statusLabel = (status: string) =>
  status.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
export const statusVariant = (status: string) =>
  status === "completed" ? "default" : status === "cancelled" ? "destructive" : "secondary";
