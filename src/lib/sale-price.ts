/**
 * Sale price rules shared by the product editor and the server. A product is on sale while its sale price is
 * lower than its regular price; the till and online checkout both charge the sale price, and the sale ends by
 * itself at "Sale ends" (see products_end_expired_sales).
 */
export function saleProblem(input: {
  price: number;
  sale: number | null | undefined;
  endsAt: string | null | undefined;
  now?: Date;
}): string | null {
  const { price, sale, endsAt } = input;
  const now = input.now ?? new Date();
  if (sale == null) return endsAt ? "Add a sale price, or clear the sale end date." : null;
  if (!(sale > 0)) return "The sale price must be more than R0.";
  if (sale >= price) return "The sale price must be lower than the regular price.";
  if (endsAt && new Date(endsAt).getTime() <= now.getTime())
    return "The sale end time has already passed. Pick a later time or clear it.";
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO timestamp -> the value a <input type="datetime-local"> shows, in the browser's own time zone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value (local time) -> ISO timestamp, or null when empty. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "Ends 31 Oct, 18:00" style label for lists. */
export function saleEndsLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return `Ends ${d.toLocaleDateString("en-ZA", { day: "numeric", month: "short" })}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Sale price for "x% off" the regular price, to the cent (never below R0.01). */
export function salePriceFromPercent(regular: number, percent: number): number {
  const p = Math.min(Math.max(percent, 0), 99);
  return Math.max(Math.round(regular * (100 - p)) / 100, 0.01);
}

/** "20% off" for a sale price against the regular price (whole percent). */
export function percentOff(regular: number, sale: number): number {
  return regular > 0 ? Math.round((1 - sale / regular) * 100) : 0;
}

export type SaleEnds = "none" | "today" | "3d" | "7d" | "custom";

/** End of the chosen period, in the browser's local time. */
export function endsAtFor(choice: SaleEnds, custom: string, now = new Date()): string | null {
  if (choice === "none") return null;
  if (choice === "custom") return fromLocalInput(custom);
  const d = new Date(now);
  d.setHours(23, 59, 0, 0);
  if (choice === "3d") d.setDate(d.getDate() + 2);
  if (choice === "7d") d.setDate(d.getDate() + 6);
  return d.toISOString();
}
