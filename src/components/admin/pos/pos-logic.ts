/**
 * Pure POS helpers (no React, no network) so they can be unit-tested.
 *
 * IMPORTANT: everything here is presentation-only. The server recomputes every price, total and
 * stock decision in PostgreSQL; a mismatch between these numbers and the server's is rejected
 * server-side (tender_mismatch / insufficient_stock), never trusted.
 */

export type TenderMethod = "cash" | "card" | "eft" | "paypal";

export const TENDER_METHODS: { id: TenderMethod; label: string; needsReference: boolean }[] = [
  { id: "cash", label: "Cash", needsReference: false },
  { id: "card", label: "Card", needsReference: true },
  { id: "eft", label: "EFT", needsReference: true },
  { id: "paypal", label: "PayPal", needsReference: true },
];

export type CatalogItem = {
  id: string;
  slug: string;
  name: string;
  category: string;
  subcategory: string | null;
  strain_type: string | null;
  unit: string | null;
  price_rand: number;
  /** The normal price while a sale runs (shown struck through); price_rand is what the till charges. */
  regular_price_rand?: number | null;
  /** When the sale ends (ISO), if it has an end. */
  sale_ends_at?: string | null;
  available: number;
};

/** A discount the cashier typed: a percentage ("10") or a rand amount ("15.50"). The server works out the cents. */
export type DiscountInput = { kind: "percent" | "amount"; value: string };

export type CartLine = {
  product: CatalogItem;
  quantity: number;
  discount?: DiscountInput | undefined;
};

export type TenderRow = { rowId: string; method: TenderMethod; amount: string; reference: string };

/** Parses "12", "12.5", "12.50" (max 2 decimals, non-negative) to integer cents; null when invalid. */
export function parseCents(input: string): number | null {
  const s = input.trim().replace(/^R\s*/i, "");
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) return null;
  const [whole = "0", frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export const centsToAmount = (cents: number): string => (cents / 100).toFixed(2);

export const priceCents = (price: number): number => Math.round(price * 100);

export function cartTotalCents(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + priceCents(l.product.price_rand) * l.quantity, 0);
}

/**
 * Cents a discount takes off `baseCents`, or null when it is empty or invalid (so the till shows nothing
 * rather than a wrong number). Same rounding as the database, which has the final say.
 */
export function discountCents(
  d: DiscountInput | null | undefined,
  baseCents: number,
): number | null {
  if (!d || !d.value.trim()) return 0;
  const v = d.value.trim().replace(/^R\s*/i, "");
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(v)) return null;
  const cents =
    d.kind === "percent"
      ? Number(v) > 100
        ? null
        : Math.round((baseCents * Number(v)) / 100)
      : Math.round(Number(v) * 100);
  return cents === null || cents > baseCents ? null : cents;
}

export type CartSummary = {
  grossCents: number;
  lineDiscountCents: number;
  orderDiscountCents: number;
  /** What the customer pays. */
  totalCents: number;
  /** False when any typed discount is not valid yet. */
  discountsValid: boolean;
  hasDiscount: boolean;
};

export function cartSummary(lines: CartLine[], orderDiscount?: DiscountInput | null): CartSummary {
  let gross = 0;
  let lineDisc = 0;
  let valid = true;
  for (const l of lines) {
    const base = priceCents(l.product.price_rand) * l.quantity;
    gross += base;
    const d = discountCents(l.discount, base);
    if (d === null) valid = false;
    else lineDisc += d;
  }
  const net = gross - lineDisc;
  const o = discountCents(orderDiscount, net);
  if (o === null) valid = false;
  const orderDisc = o ?? 0;
  const total = net - orderDisc;
  if (net > 0 && total <= 0) valid = false;
  return {
    grossCents: gross,
    lineDiscountCents: lineDisc,
    orderDiscountCents: orderDisc,
    totalCents: total,
    discountsValid: valid,
    hasDiscount: lineDisc + orderDisc > 0,
  };
}

/** The discount to send, or undefined when empty. */
export const sendableDiscount = (d: DiscountInput | null | undefined) =>
  d && d.value.trim() ? { kind: d.kind, value: d.value.trim().replace(/^R\s*/i, "") } : undefined;

/**
 * Cents to hand back for `qty` more units of a line, given what was paid for the line (after any discount).
 * Same cumulative rounding as the database, so the refund of a whole line adds up to its line_total exactly.
 */
export function refundLineCents(
  lineTotal: number,
  quantity: number,
  alreadyRefunded: number,
  qty: number,
): number {
  if (qty <= 0 || quantity <= 0) return 0;
  const total = Math.round(lineTotal * 100);
  const upTo = (n: number) => Math.round((total * n) / quantity);
  return upTo(alreadyRefunded + qty) - upTo(alreadyRefunded);
}

export const clampQuantity = (quantity: number, available: number): number => {
  if (!Number.isFinite(quantity)) return 1;
  return Math.max(1, Math.min(Math.floor(quantity), Math.max(available, 1), 9999));
};

/** "3*blue gelato" -> { quantity: 3, term: "blue gelato" }; plain text -> quantity 1. */
export function parseQuickQuantity(query: string): { quantity: number; term: string } {
  const m = /^\s*(\d{1,4})\s*[*x×]\s*(.*)$/i.exec(query);
  if (!m) return { quantity: 1, term: query.trim() };
  return { quantity: Math.max(1, Number(m[1])), term: (m[2] ?? "").trim() };
}

/** Speed-first search: every whitespace-separated token must match name/category/strain/slug. */
export function searchCatalog(
  catalog: CatalogItem[],
  query: string,
  limit = 8,
  category: string | null = null,
): CatalogItem[] {
  const { term } = parseQuickQuantity(query);
  const tokens = term.toLowerCase().split(/\s+/).filter(Boolean);
  const inCategory = category ? catalog.filter((p) => p.category === category) : catalog;
  const matches = tokens.length
    ? inCategory.filter((p) => {
        const hay =
          `${p.name} ${p.category} ${p.subcategory ?? ""} ${p.strain_type ?? ""} ${p.slug}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      })
    : inCategory;
  // In-stock first, then name-prefix matches, then the catalogue's own order.
  const first = tokens[0] ?? "";
  return [...matches]
    .sort((a, b) => {
      const stock = Number(b.available > 0) - Number(a.available > 0);
      if (stock) return stock;
      const prefix =
        Number(b.name.toLowerCase().startsWith(first)) -
        Number(a.name.toLowerCase().startsWith(first));
      return prefix;
    })
    .slice(0, limit);
}

/** Categories on the till, in catalogue order of first appearance, with how many products each has. */
export function categoryCounts(catalog: CatalogItem[]): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of catalog)
    if (p.category) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  return [...counts]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

export function addToCart(lines: CartLine[], product: CatalogItem, quantity = 1): CartLine[] {
  const existing = lines.find((l) => l.product.id === product.id);
  if (existing) {
    return lines.map((l) =>
      l.product.id === product.id
        ? { ...l, quantity: clampQuantity(l.quantity + quantity, product.available) }
        : l,
    );
  }
  return [...lines, { product, quantity: clampQuantity(quantity, product.available) }];
}

export function setLineQuantity(
  lines: CartLine[],
  productId: string,
  quantity: number,
): CartLine[] {
  return lines.map((l) =>
    l.product.id === productId
      ? { ...l, quantity: clampQuantity(quantity, l.product.available) }
      : l,
  );
}

export const removeLine = (lines: CartLine[], productId: string): CartLine[] =>
  lines.filter((l) => l.product.id !== productId);

export type TenderStatus = {
  sumCents: number;
  remainingCents: number;
  overCents: number;
  allValid: boolean;
  /**
   * The first card or EFT reference typed on more than one payment in this sale, if any. Every payment needs its
   * own slip or bank reference: the database refuses a reused one (so one slip cannot be counted twice).
   */
  duplicateReference: string | null;
  /** True only when every row is valid and the tenders equal the total exactly (server re-checks). */
  ok: boolean;
};

export function tenderStatus(totalCents: number, tenders: TenderRow[]): TenderStatus {
  let sum = 0;
  let allValid = tenders.length > 0;
  let duplicateReference: string | null = null;
  const seen = new Set<string>();
  for (const t of tenders) {
    const cents = parseCents(t.amount);
    const needsRef = TENDER_METHODS.find((m) => m.id === t.method)?.needsReference ?? false;
    if (cents === null || cents <= 0 || (needsRef && t.reference.trim().length < 4))
      allValid = false;
    const ref = t.reference.trim();
    if (needsRef && ref) {
      const k = `${t.method}\u0000${ref}`; // the database's rule: the same method and the same reference
      if (seen.has(k) && !duplicateReference) duplicateReference = ref;
      seen.add(k);
    }
    sum += cents ?? 0;
  }
  return {
    sumCents: sum,
    remainingCents: Math.max(totalCents - sum, 0),
    overCents: Math.max(sum - totalCents, 0),
    allValid,
    duplicateReference,
    ok: allValid && duplicateReference === null && totalCents > 0 && sum === totalCents,
  };
}

/** Change to hand back for a cash payment where the customer gave `receivedCents`. */
export const cashChangeCents = (receivedCents: number, cashTenderCents: number): number =>
  Math.max(receivedCents - cashTenderCents, 0);

/**
 * Idempotency keys. A retry of the SAME request must reuse its key (so the server replays instead of
 * double-charging); a CHANGED request must get a fresh key (the server rejects key reuse with a
 * different payload). Keys are tied to a signature of the request.
 */
export function createKeyStore(gen: () => string = () => crypto.randomUUID()) {
  let current: { sig: string; key: string } | null = null;
  return {
    keyFor(signature: string): string {
      if (!current || current.sig !== signature) current = { sig: signature, key: gen() };
      return current.key;
    },
    reset(): void {
      current = null;
    },
  };
}

export const salesSignature = (payload: unknown): string => JSON.stringify(payload);

/** Distributes a refund across the sale's tender methods (largest remaining capacity first). */
export function defaultPayouts(
  amountCents: number,
  capacityByMethod: Partial<Record<TenderMethod, number>>,
): { method: TenderMethod; cents: number }[] {
  const order = (Object.entries(capacityByMethod) as [TenderMethod, number][])
    .filter(([, cap]) => cap > 0)
    .sort((a, b) => b[1] - a[1]);
  const out: { method: TenderMethod; cents: number }[] = [];
  let left = amountCents;
  for (const [method, cap] of order) {
    if (left <= 0) break;
    const take = Math.min(left, cap);
    out.push({ method, cents: take });
    left -= take;
  }
  return out;
}
