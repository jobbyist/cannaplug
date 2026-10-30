import { describe, expect, it } from "vitest";
import {
  batchNote,
  isOutdoorFlower,
  quantityLabel,
  saleStep,
  snapDown,
  snapUp,
} from "@/lib/sale-step";
import {
  addToCart,
  clampQuantity,
  setLineQuantity,
  stepLine,
  type CartLine,
  type CatalogItem,
} from "@/components/admin/pos/pos-logic";

const outdoor = {
  category: "Flower",
  subcategory: "Outdoor",
  name: "Astro Grape (Outdoor)",
  sold_by_weight: true,
  weight_step_g: 1,
};
const greenhouse = { ...outdoor, subcategory: "Greenhouse", name: "Blue Gelato (Greenhouse)" };

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: "p1",
  slug: "p1",
  name: "Astro Grape (Outdoor)",
  category: "Flower",
  subcategory: "Outdoor",
  strain_type: null,
  unit: "g",
  price_rand: 24,
  available: 60,
  sold_by_weight: true,
  weight_step_g: 1,
  ...over,
});

describe("sale step", () => {
  it("Outdoor flower sold by weight moves in 5 g, whatever step is stored", () => {
    expect(saleStep(outdoor)).toBe(5);
    expect(saleStep({ ...outdoor, weight_step_g: 0.5 })).toBe(5);
    expect(saleStep({ ...outdoor, subcategory: null })).toBe(5); // the grade in the name is enough
    expect(isOutdoorFlower({ ...outdoor, subcategory: null, name: "Frozen Bag (outdoor)" })).toBe(
      true,
    );
  });

  it("other products are not affected", () => {
    expect(saleStep(greenhouse)).toBe(1);
    expect(saleStep({ ...outdoor, sold_by_weight: false })).toBe(1); // a bag sold as one unit
    expect(saleStep({ ...outdoor, category: "Pre-rolls" })).toBe(1);
    expect(saleStep({ category: "Edibles" })).toBe(1);
  });

  it("a stored step of 5 on any weighed product is honoured, and odd values fall back to 1", () => {
    expect(saleStep({ ...greenhouse, weight_step_g: 5 })).toBe(5);
    expect(saleStep({ ...greenhouse, weight_step_g: "5.0" })).toBe(5);
    expect(saleStep({ ...greenhouse, weight_step_g: 0.5 })).toBe(1);
    expect(saleStep({ ...greenhouse, weight_step_g: null })).toBe(1);
  });

  it("snaps to whole batches", () => {
    expect(snapUp(1, 5)).toBe(5);
    expect(snapUp(5, 5)).toBe(5);
    expect(snapUp(6, 5)).toBe(10);
    expect(snapUp(0, 5)).toBe(5);
    expect(snapUp(Number.NaN, 5)).toBe(5);
    expect(snapDown(14, 5)).toBe(10);
    expect(snapDown(4, 5)).toBe(0);
  });

  it("describes the batch for the shop", () => {
    expect(batchNote({ ...outdoor, price_rand: 24 })).toBe("Sold in 5 g batches (R120 a bag)");
    expect(batchNote({ ...greenhouse, price_rand: 50 })).toBeNull();
    expect(quantityLabel(10, true)).toBe("10 g");
    expect(quantityLabel(3, false)).toBe("3");
  });
});

describe("till basket for Outdoor flower", () => {
  it("adds a whole batch, never a part of one", () => {
    const lines = addToCart([], item());
    expect(lines[0]!.quantity).toBe(5);
    expect(addToCart(lines, item())[0]!.quantity).toBe(10);
    expect(addToCart([], item(), 7)[0]!.quantity).toBe(10); // "7*grape" rounds up to a full batch
  });

  it("+ and - move 5 g and stop at one batch", () => {
    let lines: CartLine[] = addToCart([], item());
    lines = stepLine(lines, "p1", 1);
    expect(lines[0]!.quantity).toBe(10);
    lines = stepLine(lines, "p1", -1);
    lines = stepLine(lines, "p1", -1);
    expect(lines[0]!.quantity).toBe(5);
  });

  it("a typed quantity snaps to a batch and never goes over stock", () => {
    const lines = addToCart([], item());
    expect(setLineQuantity(lines, "p1", 12)[0]!.quantity).toBe(15);
    expect(setLineQuantity(lines, "p1", 999)[0]!.quantity).toBe(60);
    expect(clampQuantity(61, 62, 5)).toBe(60);
    expect(clampQuantity(3, 4, 5)).toBe(5); // less than a batch left: the sale is refused by stock, not rounded down to nothing
  });

  it("stops adding when the next batch is more than is in stock", () => {
    const lines = addToCart([], item({ available: 12 }));
    expect(stepLine(addToCart(lines, item({ available: 12 })), "p1", 1)[0]!.quantity).toBe(10);
  });

  it("other products still move one at a time", () => {
    const g = item({ id: "g1", name: "Blue Gelato (Greenhouse)", subcategory: "Greenhouse" });
    let lines: CartLine[] = addToCart([], g);
    expect(lines[0]!.quantity).toBe(1);
    lines = stepLine(lines, "g1", 1);
    expect(lines[0]!.quantity).toBe(2);
    expect(setLineQuantity(lines, "g1", 7)[0]!.quantity).toBe(7);
  });
});
