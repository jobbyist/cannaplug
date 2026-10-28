import { describe, expect, it } from "vitest";
import {
  activeFilters,
  facets,
  filterProducts,
  parseShopSearch,
  resolveShopSearch,
  shopHeading,
  sortProducts,
  strainOf,
  withCategory,
  withoutFilter,
  type ShopProduct,
} from "@/lib/shop-filter";

let n = 0;
const p = (o: Partial<ShopProduct> & { name: string; category: string }): ShopProduct => ({
  id: `p${++n}`,
  subcategory: null,
  strain_type: null,
  description: null,
  price_rand: 100,
  regular_price_rand: null,
  in_stock: true,
  ...o,
});

const PRODUCTS: ShopProduct[] = [
  p({ name: "Astro Grape (Outdoor)", category: "Flower", subcategory: "Outdoor", price_rand: 24 }),
  p({
    name: "Jealousy (Greenhouse)",
    category: "Flower",
    subcategory: "Greenhouse",
    price_rand: 50,
    strain_type: "Indica",
  }),
  p({
    name: "Orange Cali (Greenhouse)",
    category: "Flower",
    subcategory: "Greenhouse",
    price_rand: 50,
    strain_type: "sativa-dominant",
    in_stock: false,
  }),
  p({
    name: "Zaza (Top Shelf)",
    category: "Flower",
    subcategory: "Top Shelf",
    price_rand: 120,
    strain_type: "Hybrid",
  }),
  p({
    name: "Sour OG Stick (Greenhouse)",
    category: "Pre-rolls",
    subcategory: "Greenhouse",
    price_rand: 50,
  }),
  p({
    name: "Runtz Stick (Top Shelf)",
    category: "Pre-rolls",
    subcategory: "Top Shelf",
    price_rand: 120,
    regular_price_rand: 140,
  }),
  p({ name: "Moonstick", category: "Pre-rolls", price_rand: 140 }),
  p({ name: "Gummy Bears", category: "Edibles", price_rand: 60, description: "Soft sweets" }),
  p({ name: "Rolling Tray", category: "Accessories", price_rand: 2 }),
  p({ name: "Lounge Pass", category: "Lounge", price_rand: 500 }),
];
const names = (list: ShopProduct[]) => list.map((x) => x.name);

describe("reading the address bar", () => {
  it("keeps what is valid and drops the rest, so /shop stays /shop", () => {
    expect(parseShopSearch({})).toEqual({});
    expect(
      parseShopSearch({
        category: "  flower ",
        sub: "top shelf",
        strain: "SATIVA-dominant",
        q: " cheese   cake ",
        sort: "price-desc",
        min: "10",
        max: 200.4,
        stock: "1",
        sale: true,
      }),
    ).toEqual({
      category: "flower",
      sub: "top shelf",
      strain: "Sativa",
      q: "cheese cake",
      sort: "price-desc",
      min: 10,
      max: 200,
      stock: true,
      sale: true,
    });
    expect(
      parseShopSearch({
        sort: "featured",
        strain: "purple",
        min: "abc",
        max: -5,
        stock: "0",
        category: 5,
      }),
    ).toEqual({});
  });

  it("reads free-text strain fields as Indica, Sativa or Hybrid", () => {
    expect(strainOf("Indica")).toBe("Indica");
    expect(strainOf(" hybrid ")).toBe("Hybrid");
    expect(strainOf("Sativa-dominant")).toBe("Sativa");
    expect(strainOf("CBD")).toBeNull();
    expect(strainOf(null)).toBeNull();
  });

  it("matches a category or subcategory in any case, spells it the shop's way, and drops ones that don't exist", () => {
    expect(resolveShopSearch({ category: "flower", sub: "TOP shelf" }, PRODUCTS)).toEqual({
      category: "Flower",
      sub: "Top Shelf",
    });
    expect(resolveShopSearch({ category: "Lounge" }, PRODUCTS)).toEqual({ category: "Lounge" });
    expect(resolveShopSearch({ category: "Nope", sub: "Top Shelf" }, PRODUCTS)).toEqual({});
    // a subcategory of another category is not kept
    expect(resolveShopSearch({ category: "Edibles", sub: "Top Shelf" }, PRODUCTS)).toEqual({
      category: "Edibles",
    });
    expect(resolveShopSearch({ min: 90, max: 20 }, PRODUCTS)).toEqual({ min: 20, max: 90 });
  });
});

describe("which products match", () => {
  it("every filter works on its own", () => {
    expect(names(filterProducts(PRODUCTS, { category: "Flower" }))).toHaveLength(4);
    expect(names(filterProducts(PRODUCTS, { category: "Flower", sub: "Greenhouse" }))).toEqual([
      "Jealousy (Greenhouse)",
      "Orange Cali (Greenhouse)",
    ]);
    expect(names(filterProducts(PRODUCTS, { strain: "Sativa" }))).toEqual([
      "Orange Cali (Greenhouse)",
    ]);
    expect(names(filterProducts(PRODUCTS, { stock: true }))).not.toContain(
      "Orange Cali (Greenhouse)",
    );
    expect(names(filterProducts(PRODUCTS, { sale: true }))).toEqual(["Runtz Stick (Top Shelf)"]);
    expect(names(filterProducts(PRODUCTS, { min: 100, max: 130 }))).toEqual([
      "Zaza (Top Shelf)",
      "Runtz Stick (Top Shelf)",
    ]);
    expect(names(filterProducts(PRODUCTS, { q: "sweets" }))).toEqual(["Gummy Bears"]);
    expect(names(filterProducts(PRODUCTS, { q: "top shelf" }))).toEqual([
      "Zaza (Top Shelf)",
      "Runtz Stick (Top Shelf)",
    ]);
    expect(names(filterProducts(PRODUCTS, { q: "PRE-ROLLS greenhouse" }))).toEqual([
      "Sour OG Stick (Greenhouse)",
    ]);
  });

  it("filters combine, and a subcategory only narrows its own category", () => {
    expect(names(filterProducts(PRODUCTS, { sub: "Top Shelf" }))).toEqual([
      "Zaza (Top Shelf)",
      "Runtz Stick (Top Shelf)",
    ]);
    expect(
      names(filterProducts(PRODUCTS, { category: "Pre-rolls", sub: "Top Shelf", sale: true })),
    ).toEqual(["Runtz Stick (Top Shelf)"]);
    expect(filterProducts(PRODUCTS, { category: "Flower", sale: true })).toEqual([]);
  });

  it("a category that is not in the usual list (Lounge) is reachable", () => {
    expect(names(filterProducts(PRODUCTS, { category: "lounge" }))).toEqual(["Lounge Pass"]);
  });

  it("a sale price that is not lower is not a sale", () => {
    const same = p({ name: "Same", category: "Flower", price_rand: 50, regular_price_rand: 50 });
    expect(filterProducts([same], { sale: true })).toEqual([]);
  });
});

describe("counts for each choice", () => {
  const f = facets(PRODUCTS, { category: "Flower", sub: "Greenhouse" });

  it("categories are counted without the category choice, so the others never read zero after a click", () => {
    expect(f.categories.map((c) => [c.name, c.count])).toEqual([
      ["Flower", 4],
      ["Pre-rolls", 3],
      ["Edibles", 1],
      ["Accessories", 1],
      ["Lounge", 1],
    ]);
  });

  it("subcategories of the chosen category, in grade order, counted without the subcategory choice", () => {
    expect(f.subcategories).toEqual([
      { name: "Outdoor", count: 1 },
      { name: "Greenhouse", count: 2 },
      { name: "Top Shelf", count: 1 },
    ]);
    expect(facets(PRODUCTS, {}).subcategories).toEqual([]);
  });

  it("counts strains, stock and sales against the other filters", () => {
    expect(f.strains).toEqual([
      { name: "Indica", count: 1 },
      { name: "Sativa", count: 1 },
      { name: "Hybrid", count: 0 },
    ]);
    expect(f.inStock).toBe(1);
    expect(f.onSale).toBe(0);
    expect(facets(PRODUCTS, {}).onSale).toBe(1);
  });

  it("price bounds follow everything except the price range", () => {
    expect(f.price).toEqual({ min: 50, max: 50 });
    expect(facets(PRODUCTS, { category: "Flower", min: 100 }).price).toEqual({ min: 24, max: 120 });
    expect(facets(PRODUCTS, { category: "Flower", q: "zzz" }).price).toBeNull();
    expect(
      facets(
        [
          p({ name: "Odd", category: "Flower", price_rand: 12.4 }),
          p({ name: "Odder", category: "Flower", price_rand: 99.2 }),
        ],
        {},
      ).price,
    ).toEqual({ min: 12, max: 100 });
  });
});

describe("sorting", () => {
  it("featured keeps the shop's order, the others sort and stay stable", () => {
    expect(sortProducts(PRODUCTS, "featured")).toEqual(PRODUCTS);
    expect(names(sortProducts(PRODUCTS, "price-asc")).slice(0, 3)).toEqual([
      "Rolling Tray",
      "Astro Grape (Outdoor)",
      "Jealousy (Greenhouse)",
    ]);
    expect(names(sortProducts(PRODUCTS, "price-desc"))[0]).toBe("Lounge Pass");
    expect(names(sortProducts(PRODUCTS, "name"))[0]).toBe("Astro Grape (Outdoor)");
    const tied = names(sortProducts(PRODUCTS, "price-asc")).filter((x) => x.includes("Greenhouse"));
    expect(tied).toEqual([
      "Jealousy (Greenhouse)",
      "Orange Cali (Greenhouse)",
      "Sour OG Stick (Greenhouse)",
    ]);
  });
});

describe("changing the filters", () => {
  it("a new category clears the subcategory and price range and keeps the rest", () => {
    expect(
      withCategory(
        {
          category: "Flower",
          sub: "Top Shelf",
          min: 10,
          max: 99,
          strain: "Indica",
          stock: true,
          q: "x",
        },
        "Edibles",
      ),
    ).toEqual({
      category: "Edibles",
      strain: "Indica",
      stock: true,
      q: "x",
    });
    expect(withCategory({ category: "Flower", sub: "Top Shelf" }, undefined)).toEqual({});
  });

  it("lists what is narrowing the results, and each can be removed", () => {
    const s = {
      category: "Flower",
      sub: "Top Shelf",
      strain: "Hybrid" as const,
      q: "za",
      min: 10,
      max: 150,
      stock: true as const,
      sale: true as const,
    };
    expect(activeFilters(s).map((c) => c.label)).toEqual([
      "Top Shelf",
      "Hybrid",
      "“za”",
      "R10 – R150",
      "In stock",
      "On sale",
    ]);
    expect(withoutFilter(s, "price")).not.toHaveProperty("min");
    expect(withoutFilter(s, "sub")).not.toHaveProperty("sub");
    expect(withoutFilter(s, "stock")).not.toHaveProperty("stock");
    expect(withoutFilter(s, "q")).not.toHaveProperty("q");
    expect(activeFilters({ category: "Flower" })).toEqual([]);
  });

  it("titles the page after the category and subcategory", () => {
    expect(shopHeading({}).title).toBe("Shop | CannaPlug");
    expect(shopHeading({ category: "Flower", sub: "Top Shelf" })).toMatchObject({
      title: "Top Shelf Flower | Shop | CannaPlug",
    });
    expect(shopHeading({ category: "Edibles" }).description).toMatch(/Shop edibles at CannaPlug/);
  });
});
