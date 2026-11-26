import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCT_FILTERS,
  filterProducts,
  inStockIds,
  outOfStockIds,
  productCategories,
  productSubcategories,
} from "@/lib/product-filters";
import type { InventoryRow } from "@/lib/inventory-logic";

const p = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Product ${id}`,
  sku: `SKU-${id}`,
  category: "Flower",
  subcategory: null as string | null,
  is_active: true,
  ...over,
});
const row = (product_id: string, over: Partial<InventoryRow> = {}) =>
  ({
    product_id,
    track_stock: true,
    available: 5,
    low_stock_threshold: 2,
    ...over,
  }) as InventoryRow;

describe("product filters", () => {
  const products = [
    p("a", { subcategory: "Top Shelf" }),
    p("b", { subcategory: "Greenhouse", is_active: false }),
    p("c", { category: "Edibles" }),
    p("d"),
    p("e", { category: "Edibles" }),
  ];
  const levels = [
    row("a", { available: 0 }),
    row("b", { available: 0 }),
    row("c", { track_stock: false, available: 0 }),
    row("d", { available: 5 }),
    row("e", { available: 1 }), // low stock still counts as in stock
  ];
  const out = outOfStockIds(levels);
  const inn = inStockIds(levels);

  it("treats only tracked products with nothing available as out of stock", () => {
    expect([...out].sort()).toEqual(["a", "b"]);
  });
  it("treats tracked products with something available, low stock included, as in stock", () => {
    expect([...inn].sort()).toEqual(["d", "e"]);
  });
  it("filters active / inactive", () => {
    const f = (status: "active" | "inactive") =>
      filterProducts(products, { ...DEFAULT_PRODUCT_FILTERS, status }, out, inn).map((x) => x.id);
    expect(f("active")).toEqual(["a", "c", "d", "e"]);
    expect(f("inactive")).toEqual(["b"]);
  });
  it("filters category, subcategory and out of stock together", () => {
    const ids = (o: Partial<typeof DEFAULT_PRODUCT_FILTERS>) =>
      filterProducts(products, { ...DEFAULT_PRODUCT_FILTERS, ...o }, out, inn).map((x) => x.id);
    expect(ids({ category: "flower" })).toEqual(["a", "b", "d"]);
    expect(ids({ category: "Flower", subcategory: "top shelf" })).toEqual(["a"]);
    expect(ids({ stock: "out" })).toEqual(["a", "b"]);
    expect(ids({ stock: "out", status: "inactive" })).toEqual(["b"]);
    expect(ids({ stock: "in" })).toEqual(["d", "e"]);
    expect(ids({ stock: "in", category: "Flower" })).toEqual(["d"]);
    expect(ids({ q: "sku-c" })).toEqual(["c"]);
  });
  it("lists categories and subcategories in shop order", () => {
    expect(productCategories(products)).toEqual(["Flower", "Edibles"]);
    expect(productSubcategories(products, "Flower")).toEqual(["Greenhouse", "Top Shelf"]);
    expect(productSubcategories(products, "Edibles")).toEqual([]);
  });
});
