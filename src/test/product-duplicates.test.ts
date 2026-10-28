import { describe, expect, it } from "vitest";
import {
  describeDuplicate,
  findDuplicates,
  normaliseName,
  normaliseSku,
  type DuplicatePool,
} from "@/lib/product-duplicates";
import {
  PRODUCT_CSV_COLUMNS,
  parseProductCsv,
  planProductCsv,
  type ExistingProduct,
} from "@/lib/product-csv";

const pool: DuplicatePool[] = [
  {
    id: "1",
    name: "Mandarin Cookies (Greendoor)",
    category: "Flower",
    sku: "GD-MC",
    is_active: true,
  },
  {
    id: "2",
    name: "Orange Road Stick (Greenhouse)",
    category: "Pre-rolls",
    sku: "ORS(001",
    is_active: true,
  },
  { id: "3", name: "Fudge 100mg", category: "Edibles", sku: null, is_active: false },
];

describe("duplicate matching", () => {
  it("normalises names and SKUs", () => {
    expect(normaliseName("  Mandarin  COOKIES (Greendoor) ")).toBe("mandarin cookies greendoor");
    expect(normaliseSku("OCS(001")).toBe("ocs001");
    expect(normaliseSku("ocs-001")).toBe("ocs001");
  });

  it("flags the same name and category, ignoring case and punctuation", () => {
    const m = findDuplicates(
      { name: "mandarin cookies greendoor", category: "flower", sku: "MC(001" },
      pool,
    );
    expect(m.map((x) => [x.id, x.reason])).toEqual([["1", "same_name"]]);
    expect(describeDuplicate(m[0]!)).toMatch(/Same name and category as Mandarin Cookies/);
  });

  it("does not flag the same name in another category, nor strength variants", () => {
    expect(findDuplicates({ name: "Fudge 100mg", category: "Flower" }, pool)).toEqual([]);
    expect(findDuplicates({ name: "Fudge 200mg", category: "Edibles" }, pool)).toEqual([]);
  });

  it("flags a SKU that differs only by punctuation or case, but not the identical SKU (an update)", () => {
    expect(
      findDuplicates({ name: "Other", category: "Flower", sku: "ors-001" }, pool)[0]?.reason,
    ).toBe("similar_sku");
    expect(
      findDuplicates(
        { name: "Mandarin Cookies (Greendoor)", category: "Flower", sku: "GD-MC" },
        pool,
      ),
    ).toEqual([]);
  });

  it("never matches the product being edited, and marks hidden matches", () => {
    expect(
      findDuplicates({ id: "1", name: "Mandarin Cookies (Greendoor)", category: "Flower" }, pool),
    ).toEqual([]);
    const m = findDuplicates({ name: "Fudge 100mg", category: "Edibles" }, pool);
    expect(describeDuplicate(m[0]!)).toMatch(/no SKU\) in Edibles, hidden/);
  });
});

const H = PRODUCT_CSV_COLUMNS.join(",");
const existing = (over: Partial<ExistingProduct>): ExistingProduct => ({
  id: "e1",
  sku: "GD-MC",
  slug: "mc",
  name: "Mandarin Cookies (Greendoor)",
  category: "Flower",
  price_rand: "120.00",
  regular_price_rand: null,
  sale_ends_at: null,
  cost_rand: null,
  brand: null,
  barcode: null,
  unit: "g",
  description: null,
  sold_by_weight: true,
  weight_step_g: 1,
  sell_online: true,
  is_featured: false,
  is_active: true,
  has_stock_history: true,
  ...over,
});
const csv = (...rows: string[][]) =>
  ["sku,name,category,price", ...rows.map((r) => r.join(","))].join("\n");
const plan = (text: string, ex: ExistingProduct[]) => planProductCsv(parseProductCsv(text), ex);

describe("CSV upload duplicate warnings", () => {
  it("warns about a new SKU with an existing name, and still plans the create", () => {
    const p = plan(csv(["MC(001", "Mandarin Cookies (Greendoor)", "Flower", "120"]), [
      existing({}),
    ]);
    expect(p.issues).toEqual([]);
    expect(p.creates).toHaveLength(1);
    expect(p.duplicates).toHaveLength(1);
    expect(p.duplicates[0]).toMatchObject({ sku: "MC(001" });
    expect(p.duplicates[0]!.problems[0]).toMatch(/GD-MC/);
  });

  it("warns when two rows in the file are the same product under different SKUs", () => {
    const p = plan(
      csv(["A-1", "Lemon Haze", "Flower", "100"], ["A-2", "lemon haze", "Flower", "100"]),
      [],
    );
    expect(p.duplicates.map((d) => d.sku)).toEqual(["A-2"]);
  });

  it("warns on a new SKU that is an existing SKU written differently", () => {
    const p = plan(csv(["gd mc", "Something Else", "Flower", "50"]), [existing({})]);
    expect(p.duplicates).toHaveLength(1);
  });

  it("is silent for an update by SKU and for a clean new product", () => {
    expect(
      plan(csv(["GD-MC", "Mandarin Cookies (Greendoor)", "Flower", "130"]), [existing({})])
        .duplicates,
    ).toEqual([]);
    expect(plan(csv(["NEW-1", "Brand New", "Flower", "50"]), [existing({})]).duplicates).toEqual(
      [],
    );
  });

  it("warns when a rename makes an existing product match another", () => {
    const other = existing({ id: "e2", sku: "X-1", name: "Gelato", category: "Flower" });
    const p = plan(csv(["GD-MC", "Gelato", "Flower", "120"]), [existing({}), other]);
    expect(p.duplicates).toHaveLength(1);
    expect(p.updates).toHaveLength(1);
  });
});
void H;
