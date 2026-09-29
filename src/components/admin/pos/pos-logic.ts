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
  available: number;
};

export type CartLine = { product: CatalogItem; quantity: number };

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
export function searchCatalog(catalog: CatalogItem[], query: string, limit = 8): CatalogItem[] {
  const { term } = parseQuickQuantity(query);
  const tokens = term.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = tokens.length
    ? catalog.filter((p) => {
        const hay =
          `${p.name} ${p.category} ${p.subcategory ?? ""} ${p.strain_type ?? ""} ${p.slug}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      })
    : catalog;
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
  /** True only when every row is valid and the tenders equal the total exactly (server re-checks). */
  ok: boolean;
};

export function tenderStatus(totalCents: number, tenders: TenderRow[]): TenderStatus {
  let sum = 0;
  let allValid = tenders.length > 0;
  for (const t of tenders) {
    const cents = parseCents(t.amount);
    const needsRef = TENDER_METHODS.find((m) => m.id === t.method)?.needsReference ?? false;
    if (cents === null || cents <= 0 || (needsRef && t.reference.trim().length < 4))
      allValid = false;
    sum += cents ?? 0;
  }
  return {
    sumCents: sum,
    remainingCents: Math.max(totalCents - sum, 0),
    overCents: Math.max(sum - totalCents, 0),
    allValid,
    ok: allValid && totalCents > 0 && sum === totalCents,
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
