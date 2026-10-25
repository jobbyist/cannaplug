import { describe, expect, it } from "vitest";
import {
  PRODUCT_CSV_COLUMNS,
  parseBool,
  parseProductCsv,
  parseSaleEnd,
  planProductCsv,
  productCsvTemplate,
  productsToCsv,
  resolvePricing,
  type ExistingProduct,
} from "@/lib/product-csv";

const H = PRODUCT_CSV_COLUMNS.join(",");
const product = (over: Partial<ExistingProduct> = {}): ExistingProduct => ({
  id: "00000000-0000-0000-0000-000000000001",
  sku: "FL-001",
  slug: "candyland",
  name: "Candyland (Top Shelf)",
  category: "Flower",
  price_rand: "120.00",
  regular_price_rand: null,
  sale_ends_at: null,
  cost_rand: "60.00",
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
/** A file with only the columns given; other template columns are absent. */
const file = (cols: string[], ...rows: string[][]) =>
  [cols.join(","), ...rows.map((r) => r.join(","))].join("\n");
const plan = (csv: string, existing: ExistingProduct[] = [product()]) =>
  planProductCsv(parseProductCsv(csv), existing);

describe("product CSV: template and export", () => {
  it("the template has every column, UTF-8 BOM, and its example rows are skipped", () => {
    const t = productCsvTemplate();
    expect(t.startsWith("﻿" + H)).toBe(true);
    const parsed = parseProductCsv(t);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toEqual([]);
    expect(parsed.notes.join(" ")).toMatch(/2 example rows/);
  });

  it("exporting and re-uploading the catalogue changes nothing", () => {
    const existing = [
      product(),
      product({
        id: "2",
        sku: "ED-200",
        name: 'Gummies, "Super" 200mg',
        category: "Edibles",
        price_rand: "120.00",
        regular_price_rand: "140.00",
        sale_ends_at: "2026-12-31T21:59:59+00:00",
        cost_rand: null,
        barcode: "6001234567890",
        unit: null,
        description: "Line one\nline two",
        sold_by_weight: false,
        weight_step_g: "0.5",
        is_featured: true,
      }),
      product({
        id: "3",
        sku: "LG-1",
        name: "=Lounge hour",
        category: "Lounge",
        sell_online: false,
      }),
    ];
    const csv = productsToCsv(existing);
    expect(csv).toContain("'=Lounge hour"); // formula-escaped for Excel
    const p = plan(csv, existing);
    expect(p.issues).toEqual([]);
    expect(p.creates).toEqual([]);
    expect(p.updates).toEqual([]);
    expect(p.unchanged).toBe(3);
    expect(p.rpcRows).toEqual([]);
  });

  it("products without a SKU are left out of the export", () => {
    expect(
      productsToCsv([product({ sku: null })])
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });
});

describe("product CSV: cells", () => {
  it("reads yes/no, dates and South African number formats", () => {
    expect([parseBool("Yes"), parseBool("n"), parseBool("1"), parseBool("maybe")]).toEqual([
      true,
      false,
      true,
      undefined,
    ]);
    expect(parseSaleEnd("2026-11-30")).toBe("2026-11-30T23:59:59+02:00");
    expect(parseSaleEnd("30/11/2026")).toBe("2026-11-30T23:59:59+02:00");
    expect(parseSaleEnd("31/02/2026")).toBeUndefined();
    const p = parseProductCsv(file(["sku", "price", "cost"], ["A1", '"R1 250,50"', '"99,9"']));
    expect(p.rows[0]).toMatchObject({ price: "1250.50", cost: "99.90" });
  });

  it("blank keeps, '-' clears, and required fields cannot be cleared", () => {
    const p = parseProductCsv(
      file(
        ["sku", "name", "brand", "cost", "price"],
        ["A1", "", "-", "-", ""],
        ["A2", "-", "", "", "-"],
      ),
    );
    expect(p.rows[0]).toEqual({ line: 2, sku: "A1", brand: null, cost: null });
    expect(p.issues[0]!.problem).toMatch(/name cannot be cleared; price cannot be cleared/);
  });

  it("reports every bad value with its line", () => {
    const p = parseProductCsv(
      file(
        [
          "sku",
          "category",
          "price",
          "sale_ends",
          "barcode",
          "weight_step_g",
          "featured",
          "opening_stock",
        ],
        ["A1", "Weed", "abc", "next week", "12", "2", "sometimes", "1.5"],
        ["A1", "Flower", "", "", "", "", "", ""],
        ["", "Flower", "", "", "", "", "", ""],
      ),
    );
    expect(p.issues).toHaveLength(3);
    expect(p.issues[0]!.problem).toMatch(
      /Unknown category.*price is not an amount.*sale_ends.*barcode.*weight_step_g.*featured.*opening_stock/,
    );
    expect(p.issues[1]).toMatchObject({ line: 3, problem: "SKU repeated (also on line 2)" });
    expect(p.issues[2]).toMatchObject({ line: 4, problem: "Missing SKU" });
    const dup = parseProductCsv(file(["sku", "price"], ["A1", "5"], ["a1", "6"]));
    expect(dup.issues[0]).toMatchObject({ line: 3, problem: "SKU repeated (also on line 2)" });
  });

  it("needs the header row and notes unknown columns", () => {
    expect(parseProductCsv("A1,Name,10").issues[0]!.problem).toMatch(/column names/);
    const p = parseProductCsv(file(["SKU", "Colour"], ["A1", "green"]));
    expect(p.notes[0]).toMatch(/"colour" is not part of the template/);
    expect(p.rows).toEqual([{ line: 2, sku: "A1" }]);
  });

  it("refuses more than 2000 rows", () => {
    const rows = Array.from({ length: 2001 }, (_, i) => [`S${i}`, "1"]);
    expect(parseProductCsv(file(["sku", "price"], ...rows)).issues[0]!.problem).toMatch(/2000/);
  });
});

describe("product CSV: pricing rules (mirrored in bulk_upsert_products)", () => {
  const base = { price_rand: "100.00", regular_price_rand: null, sale_ends_at: null };
  const onSale = {
    price_rand: "80.00",
    regular_price_rand: "100.00",
    sale_ends_at: "2026-12-01T21:59:59Z",
  };

  it("a lower sale price puts the product on sale", () => {
    expect(resolvePricing(base, { sale_price: "75.00" })).toEqual({
      price_rand: "75.00",
      regular_price_rand: "100.00",
      sale_ends_at: null,
    });
  });
  it("a sale price that is not lower is a problem when it comes from the file", () => {
    expect(resolvePricing(base, { sale_price: "100.00" })!.problem).toMatch(/lower/);
  });
  it("a running sale ends when the new price is not above it", () => {
    const r = resolvePricing(onSale, { price: "70.00" })!;
    expect(r).toMatchObject({ price_rand: "70.00", regular_price_rand: null, sale_ends_at: null });
    expect(r.note).toMatch(/sale ends/);
  });
  it("a running sale and its end date stay when only the price rises", () => {
    expect(resolvePricing(onSale, { price: "110.00" })).toEqual({
      price_rand: "80.00",
      regular_price_rand: "110.00",
      sale_ends_at: onSale.sale_ends_at,
    });
  });
  it("'-' in sale_price ends a sale; a sale end without a sale is a problem", () => {
    expect(resolvePricing(onSale, { sale_price: null })).toMatchObject({
      price_rand: "100.00",
      regular_price_rand: null,
    });
    expect(resolvePricing(base, { sale_ends: "2026-12-01T23:59:59+02:00" })!.problem).toMatch(
      /needs a sale_price/,
    );
  });
});

describe("product CSV: plan", () => {
  it("lists field changes and sends only changed rows", () => {
    const p = plan(file(["sku", "name", "price", "brand"], ["fl-001", "Candyland", "130", ""]));
    expect(p.updates).toEqual([
      {
        line: 2,
        sku: "FL-001",
        name: "Candyland",
        changes: [
          { field: "name", from: "Candyland (Top Shelf)", to: "Candyland" },
          { field: "price", from: "120.00", to: "130.00" },
        ],
      },
    ]);
    expect(p.rpcRows).toEqual([{ sku: "fl-001", name: "Candyland", price: "130.00" }]);
  });

  it("creates new products only with name, category and price", () => {
    const p = plan(
      file(
        ["sku", "name", "category", "price", "opening_stock"],
        ["NEW-1", "Blue Dream", "flower", "150", "20"],
        ["NEW-2", "No price", "Flower", "", ""],
      ),
    );
    expect(p.creates).toEqual([
      {
        line: 2,
        sku: "NEW-1",
        name: "Blue Dream",
        category: "Flower",
        price: "150.00",
        opening_qty: 20,
      },
    ]);
    expect(p.rpcRows[0]).toMatchObject({
      sku: "NEW-1",
      slug: "blue-dream",
      opening_qty: 20,
      category: "Flower",
    });
    expect(p.issues).toEqual([{ line: 3, sku: "NEW-2", problem: "new product needs price" }]);
  });

  it("ignores opening stock for products that already have stock", () => {
    const p = plan(file(["sku", "opening_stock"], ["FL-001", "50"]));
    expect(p.updates).toEqual([]);
    expect(p.unchanged).toBe(1);
    expect(p.notes[0]).toMatch(/already has stock/);
    const fresh = plan(file(["sku", "opening_stock"], ["FL-001", "50"]), [
      product({ has_stock_history: false }),
    ]);
    expect(fresh.rpcRows).toEqual([{ sku: "FL-001", opening_qty: 50 }]);
  });

  it("refuses barcodes used by another product or twice in the file", () => {
    const existing = [product(), product({ id: "2", sku: "B-2", barcode: "ABC123" })];
    const p = plan(file(["sku", "barcode"], ["FL-001", "abc123"]), existing);
    expect(p.issues[0]!.problem).toMatch(/already used/);
    const twice = plan(file(["sku", "barcode"], ["FL-001", "XYZ999"], ["B-2", "XYZ999"]), existing);
    expect(twice.issues).toHaveLength(1);
    expect(plan(file(["sku", "barcode"], ["B-2", "ABC123"]), existing).unchanged).toBe(1);
  });

  it("keeps Lounge in store: no online selling, no moving in or out", () => {
    const lounge = product({ sku: "LG-1", category: "Lounge", sell_online: false });
    expect(
      plan(file(["sku", "sell_online"], ["LG-1", "yes"]), [lounge]).issues[0]!.problem,
    ).toMatch(/in store only/);
    expect(plan(file(["sku", "category"], ["FL-001", "Lounge"])).issues[0]!.problem).toMatch(
      /Lounge/,
    );
    const created = plan(
      file(
        ["sku", "name", "category", "price", "opening_stock"],
        ["LG-2", "Booth", "Lounge", "50", "5"],
      ),
      [],
    );
    expect(created.creates[0]!.opening_qty).toBe(0);
    expect(created.rpcRows[0]).not.toHaveProperty("opening_qty");
  });

  it("a sale price that is not below the price is a problem row", () => {
    expect(plan(file(["sku", "sale_price"], ["FL-001", "120"])).issues[0]!.problem).toMatch(
      /lower/,
    );
  });
});
