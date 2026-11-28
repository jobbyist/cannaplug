/**
 * Stock and sale quantities (25 Nov 2026): exact to one decimal place for products sold by weight (27.4 g), whole
 * numbers for everything else. The database holds them as numeric(12,1) and refuses anything finer.
 *
 * JavaScript cannot add 0.1 + 0.2 exactly, so every sum, comparison and price below goes through whole tenths
 * (27.4 g = 274 tenths). Pure functions only: no I/O, shared by the screens, the server functions and the tests.
 */

export const TENTHS = 10;
/** The most a single stock figure can be (matches the database check on a count). */
export const MAX_QTY = 1_000_000;

export const toTenths = (q: number): number => Math.round(q * TENTHS);
export const fromTenths = (t: number): number => t / TENTHS;
/** Removes floating-point noise: roundQty(0.1 + 0.2) is exactly 0.3. */
export const roundQty = (q: number): number => fromTenths(toTenths(q));
export const addQty = (a: number, b: number): number => fromTenths(toTenths(a) + toTenths(b));
export const subQty = (a: number, b: number): number => fromTenths(toTenths(a) - toTenths(b));
export const sumQty = (xs: readonly number[]): number =>
  fromTenths(xs.reduce((s, x) => s + toTenths(x), 0));

/** True when the number has at most one decimal place (27.4 yes, 27.45 no). */
export const isTenths = (q: number): boolean =>
  Number.isFinite(q) && Math.abs(q * TENTHS - Math.round(q * TENTHS)) < 1e-6;
export const isWholeQty = (q: number): boolean =>
  Number.isFinite(q) && Number.isInteger(roundQty(q));

/** 27.4 shows as "27,4" in a South African browser (like the rand amounts); whole numbers show without decimals. */
export const formatQty = (q: number): string =>
  roundQty(q)
    .toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 1 })
    .replace(/\u00a0/g, " ");
/** "27,4 g" for a weighed product, otherwise the plain number. */
export const formatQtyUnit = (q: number, byWeight: boolean | null | undefined): string =>
  byWeight ? `${formatQty(q)} g` : formatQty(q);

type ParseOptions = {
  /** Decimals are only for products sold by weight; everything else is whole units. */
  decimals: boolean;
  /** Accept 0 (a count of "none on the shelf"). Default true. */
  allowZero?: boolean;
  max?: number;
};

/**
 * What staff type into a quantity box or a spreadsheet: "27", "27.4" or "27,4" (a decimal comma). Returns null when it
 * is not a quantity: empty, negative, more than one decimal, or a decimal for a product counted in whole units.
 */
export function parseQty(raw: string, o: ParseOptions): number | null {
  const s = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^(\d{1,7}(\.\d)?|\.\d)$/.test(s)) return null;
  const n = Number(s);
  if (!o.decimals && !Number.isInteger(n)) return null;
  if (n === 0 && o.allowZero === false) return null;
  if (n > (o.max ?? MAX_QTY)) return null;
  return roundQty(n);
}

/** A plain sentence for what is wrong with a typed quantity, or null when it is fine. */
export function qtyProblem(raw: string, o: ParseOptions): string | null {
  if (parseQty(raw, o) !== null) return null;
  const s = raw.trim().replace(",", ".");
  if (s === "") return "Enter the quantity.";
  if (/^-/.test(s)) return "A quantity can't be negative.";
  if (!/^[\d.]+$/.test(s)) return "Use numbers only, like 27 or 27.4.";
  if (/\.\d{2,}/.test(s)) return "Use at most one decimal place, like 27.4.";
  if (!o.decimals && /\./.test(s)) return "This product is counted in whole units, not decimals.";
  if (o.allowZero === false && Number(s) === 0) return "The quantity must be more than 0.";
  return `Enter a quantity up to ${(o.max ?? MAX_QTY).toLocaleString("en-ZA")}.`;
}

/**
 * Keeps what is typed into a quantity box tidy: digits, and one separator followed by at most one digit ("." and ","
 * are both accepted, as typed). A decimal typed for a product counted in whole units is deliberately NOT dropped: it
 * stays visible so parseQty can say "this product is counted in whole units", instead of "2.5" silently becoming 25.
 */
export function cleanQtyInput(raw: string): string {
  const kept = raw.replace(/[^\d.,]/g, "");
  const m = /^(\d*)([.,])?(\d?)/.exec(kept);
  if (!m) return "";
  return `${m[1]}${m[2] ?? ""}${m[3] ?? ""}`;
}

/** What a line costs, in cents: unit price x quantity, rounded half up to the cent (the database's rule too). */
export function lineCents(unitPriceRand: number, quantity: number): number {
  return Math.round((Math.round(unitPriceRand * 100) * toTenths(quantity)) / TENTHS);
}
