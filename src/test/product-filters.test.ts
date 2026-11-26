import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCT_FILTERS,
  filterProducts,
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
  ];
  const out = outOfStockIds([
    row("a", { available: 0 }),
    row("b", { available: 0 }),
    row("c", { track_stock: false, available: 0 }),
  ]);

  it("treats only tracked products with nothing available as out of stock", () => {
    expect([...out].sort()).toEqual(["a", "b"]);
  });
  it("filters active / inactive", () => {
    const f = (status: "active" | "inactive") =>
      filterProducts(products, { ...DEFAULT_PRODUCT_FILTERS, status }, out).map((x) => x.id);
    expect(f("active")).toEqual(["a", "c"]);
    expect(f("inactive")).toEqual(["b"]);
  });
  it("filters category, subcategory and out of stock together", () => {
    const ids = (o: Partial<typeof DEFAULT_PRODUCT_FILTERS>) =>
      filterProducts(products, { ...DEFAULT_PRODUCT_FILTERS, ...o }, out).map((x) => x.id);
    expect(ids({ category: "flower" })).toEqual(["a", "b"]);
    expect(ids({ category: "Flower", subcategory: "top shelf" })).toEqual(["a"]);
    expect(ids({ outOfStock: true })).toEqual(["a", "b"]);
    expect(ids({ outOfStock: true, status: "inactive" })).toEqual(["b"]);
    expect(ids({ q: "sku-c" })).toEqual(["c"]);
  });
  it("lists categories and subcategories in shop order", () => {
    expect(productCategories(products)).toEqual(["Flower", "Edibles"]);
    expect(productSubcategories(products, "Flower")).toEqual(["Greenhouse", "Top Shelf"]);
    expect(productSubcategories(products, "Edibles")).toEqual([]);
  });
});
