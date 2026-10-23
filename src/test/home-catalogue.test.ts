import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pickFeatured, visibleCategories, type HomeProduct } from "@/lib/home-catalogue";

const p = (over: Partial<HomeProduct>): HomeProduct => ({
  id: Math.random().toString(36).slice(2),
  slug: "x",
  name: "Product",
  category: "Flower",
  subcategory: null,
  price_rand: 50,
  regular_price_rand: null,
  unit: null,
  badge: null,
  sold_by_weight: false,
  image_url: null,
  is_featured: false,
  sort_order: 100,
  in_stock: true,
  ...over,
});

describe("homepage catalogue", () => {
  it("shows picked in-stock products first and never an out-of-stock one", () => {
    const picked = p({ name: "Picked", is_featured: true, sort_order: 1 });
    const out = p({ name: "Sold out", is_featured: true, in_stock: false });
    const result = pickFeatured([p({ name: "Other" }), out, picked]);
    expect(result[0]!.name).toBe("Picked");
    expect(result.map((r) => r.name)).not.toContain("Sold out");
  });
  it("tops up with one product per category before repeating a category", () => {
    const list = [
      p({ name: "F1" }),
      p({ name: "F2" }),
      p({ name: "E1", category: "Edibles" }),
      p({ name: "D1", category: "Drinks" }),
    ];
    expect(pickFeatured(list, 3).map((r) => r.category)).toEqual(["Flower", "Edibles", "Drinks"]);
  });
  it("lists only categories with stock, in shop order", () => {
    const cats = visibleCategories([
      p({ category: "Accessories" }),
      p({ category: "Flower" }),
      p({ category: "Vapes", in_stock: false }),
    ]);
    expect(cats.map((c) => c.name)).toEqual(["Flower", "Accessories"]);
    expect(cats[0]!.tagline).toBe("Premium Strains");
  });
  it("the homepage no longer hard-codes products or prices", () => {
    const src = readFileSync(new URL("../components/CannaPlugHome.tsx", import.meta.url), "utf8");
    for (const mock of [
      "Gelato 33",
      "Blue Mix",
      "Mixed Flavour Gummies",
      "Raw Distillate Cart",
      "R350",
      "featured-${",
    ])
      expect(src, mock).not.toContain(mock);
  });
});
