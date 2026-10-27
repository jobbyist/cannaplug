import { describe, expect, it } from "vitest";
import {
  cartSummary,
  discountCents,
  refundLineCents,
  sendableDiscount,
  type CartLine,
  type CatalogItem,
} from "@/components/admin/pos/pos-logic";
import { buildReceiptModel, receiptText, type ReceiptSettings } from "@/lib/receipts/receipt-model";

const item = (id: string, price: number): CatalogItem => ({
  id,
  slug: id,
  name: id,
  category: "Flower",
  subcategory: null,
  strain_type: null,
  unit: null,
  price_rand: price,
  available: 99,
});

describe("till discount maths (display only; the database has the final say)", () => {
  it("percent and rand discounts, rounded to the cent", () => {
    expect(discountCents({ kind: "percent", value: "10" }, 20_000)).toBe(2_000);
    expect(discountCents({ kind: "percent", value: "33.33" }, 1_000)).toBe(333);
    expect(discountCents({ kind: "amount", value: "15.50" }, 20_000)).toBe(1_550);
    expect(discountCents({ kind: "amount", value: "R 5" }, 20_000)).toBe(500);
    expect(discountCents(undefined, 20_000)).toBe(0);
    expect(discountCents({ kind: "percent", value: "" }, 20_000)).toBe(0);
  });

  it("rejects what the server would reject", () => {
    expect(discountCents({ kind: "percent", value: "101" }, 20_000)).toBeNull();
    expect(discountCents({ kind: "amount", value: "200.01" }, 20_000)).toBeNull();
    expect(discountCents({ kind: "amount", value: "-5" }, 20_000)).toBeNull();
    expect(discountCents({ kind: "amount", value: "1.234" }, 20_000)).toBeNull();
    expect(discountCents({ kind: "percent", value: "abc" }, 20_000)).toBeNull();
  });

  it("line discounts first, then the order discount on what is left", () => {
    const lines: CartLine[] = [
      { product: item("a", 100), quantity: 1, discount: { kind: "percent", value: "10" } },
      { product: item("b", 50), quantity: 2 },
    ];
    const s = cartSummary(lines, { kind: "percent", value: "10" });
    expect(s.grossCents).toBe(20_000);
    expect(s.lineDiscountCents).toBe(1_000);
    expect(s.orderDiscountCents).toBe(1_900);
    expect(s.totalCents).toBe(17_100);
    expect(s.hasDiscount).toBe(true);
    expect(s.discountsValid).toBe(true);
  });

  it("an empty basket and a plain sale are unchanged", () => {
    expect(cartSummary([]).totalCents).toBe(0);
    const s = cartSummary([{ product: item("a", 12.5), quantity: 3 }]);
    expect(s.totalCents).toBe(3_750);
    expect(s.hasDiscount).toBe(false);
  });

  it("a discount that would take the sale to zero is flagged", () => {
    const s = cartSummary([{ product: item("a", 10), quantity: 1 }], {
      kind: "percent",
      value: "100",
    });
    expect(s.discountsValid).toBe(false);
  });

  it("sends only a non-empty, trimmed discount", () => {
    expect(sendableDiscount({ kind: "amount", value: " R 5 " })).toEqual({
      kind: "amount",
      value: "5",
    });
    expect(sendableDiscount({ kind: "percent", value: "  " })).toBeUndefined();
    expect(sendableDiscount(undefined)).toBeUndefined();
  });
});

describe("receipts show the discount", () => {
  const settings: ReceiptSettings = {
    trading_name: "CannaPlug",
    legal_name: "CANNAPLUG PTY LTD",
    registration_number: null,
    licence_lines: [],
    address: "Pretoria",
    phone: null,
    email: null,
    vat_registered: false,
    vat_number: null,
    vat_rate: 15,
    footer_message: null,
    returns_policy: null,
    default_paper: "80mm",
  };
  const build = (discount: number) =>
    buildReceiptModel({
      sale: {
        receipt_number: "POS-1",
        created_at: "2026-10-27T10:00:00Z",
        status: "completed",
        subtotal: 100,
        discount_rand: discount,
        total: 100 - discount,
      },
      items: [
        {
          product_name: "Item",
          quantity: 1,
          unit_price_rand: 100,
          line_discount_rand: discount,
          order_discount_rand: 0,
          line_total: 100 - discount,
        },
      ],
      tenders: [{ method: "cash", amount: 100 - discount, reference: null }],
      settings,
      cashierName: "Thabo",
      customerName: null,
      cashReceived: null,
      loyaltyPoints: null,
    });

  it("lists subtotal and discount when there is one", () => {
    const m = build(10);
    expect(m.discount).toBe(10);
    expect(m.lines[0]!.discount).toBe(10);
    const text = receiptText(m);
    expect(text).toContain("Subtotal R100,00");
    expect(text).toContain("Discount -R10,00");
    expect(text).toContain("Total R90,00");
  });

  it("prints nothing extra when there is none", () => {
    const text = receiptText(build(0));
    expect(text).not.toContain("Discount");
    expect(text).not.toContain("Subtotal");
  });
});

describe("refund amounts for a discounted line", () => {
  it("shares add up to what was paid, cent for cent", () => {
    // R300 line less R10 order discount = R290 for 3 units.
    const parts = [0, 1, 2].map((done) => refundLineCents(290, 3, done, 1));
    expect(parts).toEqual([9667, 9666, 9667]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(29000);
    expect(refundLineCents(290, 3, 0, 3)).toBe(29000);
  });
  it("is unchanged for an undiscounted line", () => {
    expect(refundLineCents(240, 2, 0, 1)).toBe(12000);
    expect(refundLineCents(240, 2, 1, 1)).toBe(12000);
    expect(refundLineCents(240, 2, 0, 0)).toBe(0);
  });
});
