// Demo till: works out a practice sale entirely in the browser. Nothing here (or in DemoTill) calls a server function
// that writes, so a demo sale leaves no sale, no stock movement, no payment record and no audit entry.
import {
  centsToAmount,
  discountCents,
  parseCents,
  priceCents,
  cartSummary,
  type CartLine,
  type CatalogItem,
  type DiscountInput,
  type TenderRow,
} from "./pos-logic";

export type DemoReceipt = {
  sale: {
    sale_id: string;
    receipt_number: string;
    total: number;
    items: { name: string; quantity: number; unit_price: number; line_total: number }[];
    tenders: { method: string; amount: number }[];
  };
  loyalty: { accrued: boolean };
  cashReceivedCents: number | null;
};

export const DEMO_PREFIX = "DEMO-";
export const demoReceiptNumber = (n: number) => `${DEMO_PREFIX}${String(n).padStart(4, "0")}`;

/** Shares the order discount across the lines by what each line is worth after its own discount (whole cents). */
function shareOrderDiscount(nets: number[], orderDiscount: number): number[] {
  const total = nets.reduce((a, b) => a + b, 0);
  if (total <= 0 || orderDiscount <= 0) return nets.map(() => 0);
  const raw = nets.map((n) => (orderDiscount * n) / total);
  const shares = raw.map(Math.floor);
  let left = orderDiscount - shares.reduce((a, b) => a + b, 0);
  const byRemainder = raw
    .map((r, i) => [r - Math.floor(r), i] as const)
    .sort((a, b) => b[0] - a[0]);
  for (const [, i] of byRemainder) {
    if (left <= 0) break;
    shares[i]! += 1;
    left -= 1;
  }
  return shares;
}

/** A practice receipt from the basket. The totals come from the same maths the till screen shows. */
export function simulateSale(input: {
  lines: CartLine[];
  orderDiscount: DiscountInput | undefined;
  tenders: TenderRow[];
  receiptNumber: string;
  cashReceived: string;
}): DemoReceipt {
  const summary = cartSummary(input.lines, input.orderDiscount);
  const nets = input.lines.map((l) => {
    const base = priceCents(l.product.price_rand) * l.quantity;
    return base - (discountCents(l.discount, base) ?? 0);
  });
  const shares = shareOrderDiscount(nets, summary.orderDiscountCents);
  return {
    sale: {
      sale_id: `demo-${input.receiptNumber}`,
      receipt_number: input.receiptNumber,
      total: summary.totalCents / 100,
      items: input.lines.map((l, i) => ({
        name: l.product.name,
        quantity: l.quantity,
        unit_price: l.product.price_rand,
        line_total: (nets[i]! - shares[i]!) / 100,
      })),
      tenders: input.tenders.map((t) => ({
        method: t.method,
        amount: Number(centsToAmount(parseCents(t.amount) ?? 0)),
      })),
    },
    loyalty: { accrued: false },
    cashReceivedCents: parseCents(input.cashReceived),
  };
}

/** The demo's own stock: a practice sale takes units off this copy only, so stock limits can be tested. */
export function takeDemoStock(catalog: CatalogItem[], lines: CartLine[]): CatalogItem[] {
  const sold = new Map(lines.map((l) => [l.product.id, l.quantity]));
  return catalog.map((p) =>
    sold.has(p.id) ? { ...p, available: Math.max(0, p.available - sold.get(p.id)!) } : p,
  );
}

/** A practice "put on sale" changes this copy of the catalogue only. */
export function applyDemoSale(
  catalog: CatalogItem[],
  input: { productId: string; salePrice: number | null },
): CatalogItem[] {
  return catalog.map((p) => {
    if (p.id !== input.productId) return p;
    const regular = Number(p.regular_price_rand ?? p.price_rand);
    return input.salePrice == null
      ? { ...p, price_rand: regular, regular_price_rand: null, sale_ends_at: null }
      : { ...p, price_rand: input.salePrice, regular_price_rand: regular };
  });
}
