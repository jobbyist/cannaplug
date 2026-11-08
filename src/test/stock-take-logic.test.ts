import { describe, expect, it } from "vitest";
import {
  countCsv,
  countSheetCsv,
  countableProducts,
  findProducts,
  parseCountCsv,
  planCountUpload,
  varianceSummary,
} from "@/lib/stock-take-logic";
import { row } from "./inventory-fixtures";

const ROWS = [
  row({ product_id: "a", name: "Thai Haze", sku: "TH-1", barcode: "600111" }),
  row({ product_id: "b", name: "Blue Haze", category: "Flower" }),
  row({ product_id: "c", name: "Rolling Papers", category: "Accessories", track_stock: false }),
  row({ product_id: "d", name: "Haze Gummies", category: "Edibles" }),
];

describe("stock take logic", () => {
  it("an exact barcode or SKU wins; otherwise every typed word must match, starts-with first", () => {
    expect(findProducts(ROWS, "600111").map((r) => r.product_id)).toEqual(["a"]);
    expect(findProducts(ROWS, "th-1").map((r) => r.product_id)).toEqual(["a"]);
    expect(findProducts(ROWS, "haze").map((r) => r.name)).toEqual([
      "Haze Gummies",
      "Blue Haze",
      "Thai Haze",
    ]);
    expect(findProducts(ROWS, "blue haze").map((r) => r.product_id)).toEqual(["b"]);
    expect(findProducts(ROWS, "  ")).toEqual([]);
  });

  it("a count covers tracked products, optionally one category", () => {
    expect(countableProducts(ROWS, null).map((r) => r.product_id)).toEqual(["a", "b", "d"]);
    expect(countableProducts(ROWS, "Edibles").map((r) => r.product_id)).toEqual(["d"]);
  });

  const line = (difference: number, unit_cost: number | null, name = "X") => ({
    product_id: name,
    name,
    category: "Flower",
    expected: 10,
    counted: 10 + difference,
    difference,
    unit_cost,
  });

  it("sums shortages and overs in units and at cost", () => {
    expect(
      varianceSummary([line(-3, 20, "a"), line(2, 5.5, "b"), line(0, 9, "c"), line(-1, null, "d")]),
    ).toEqual({
      counted: 4,
      changed: 3,
      unitsOver: 2,
      unitsUnder: 4,
      valueOver: 11,
      valueUnder: 60,
    });
    expect(varianceSummary([line(-1, null)]).valueUnder).toBeNull();
  });

  it("the spreadsheet lists the biggest differences first and cannot run formulas", () => {
    const csv = countCsv([line(1, 2, "Small"), line(-5, 2, "=HYPERLINK(evil)")]);
    const rows = csv.trim().split("\n");
    expect(rows[0]).toBe("Product,Category,System,Counted,Difference,Unit cost,Value");
    expect(rows[1]!.startsWith("'=HYPERLINK(evil)")).toBe(true);
    expect(rows[1]).toContain(",-5,2,-10.00");
    expect(rows[2]!.startsWith("Small")).toBe(true);
  });

  describe("count sheet upload", () => {
    const scope = countableProducts(ROWS, null);
    const none = new Map<string, number>();

    it("the sheet is blind (no system quantity) and round-trips through the upload", () => {
      const sheet = countSheetCsv(scope);
      expect(sheet.startsWith("\uFEFF")).toBe(true);
      const [head, ...rows] = parseCountCsv(sheet);
      expect(head).toEqual(["sku", "barcode", "name", "category", "unit", "counted"]);
      expect(rows).toHaveLength(3);
      const filled = sheet.replace(/,\r\n/g, ",4\r\n");
      const plan = planCountUpload(filled, scope, none);
      expect(plan.issues).toEqual([]);
      expect(plan.lines.map((l) => [l.product_id, l.counted]).sort()).toEqual([
        ["a", 4],
        ["b", 4],
        ["d", 4],
      ]);
    });

    it("matches by SKU, barcode, then exact name; blank = not counted", () => {
      const csv = ["sku,barcode,name,counted", "th-1,,,7", ",,blue haze,3", ",,Haze Gummies,"].join(
        "\n",
      );
      const plan = planCountUpload(csv, scope, none);
      expect(plan.lines.map((l) => [l.product_id, l.counted])).toEqual([
        ["a", 7],
        ["b", 3],
      ]);
      expect(plan.blank).toBe(1);
      expect(planCountUpload("barcode,counted\n600111,2", scope, none).lines[0]).toMatchObject({
        product_id: "a",
        counted: 2,
      });
    });

    it("reads the Inventory tab's stock sheet and Excel's semicolon files", () => {
      const stockSheet =
        "sku,name,category,brand,status,available,held,on_hand,low_stock_alert,next_expiry,counted\n" +
        "TH-1,Thai Haze,Flower,,In stock,10,0,10,5,,9\n";
      expect(planCountUpload(stockSheet, scope, none).lines[0]).toMatchObject({
        product_id: "a",
        counted: 9,
      });
      expect(
        planCountUpload('\uFEFFSKU;Name;Counted\r\n"TH-1";Thai Haze;12,0\r\n', scope, none).lines,
      ).toMatchObject([{ product_id: "a", counted: 12 }]);
    });

    it("reports bad rows by line and does not save them", () => {
      const csv = [
        "sku,name,counted",
        "TH-1,,2.5", // not whole
        ",Rolling Papers,3", // not tracked, not in the count
        "NOPE,,1",
        ",,4", // nothing to match
        "TH-1,,-1",
        ",Blue Haze,1",
        ",Blue Haze,2", // twice
      ].join("\n");
      const plan = planCountUpload(csv, scope, none);
      expect(plan.lines.map((l) => l.product_id)).toEqual(["b"]);
      expect(plan.issues.map((i) => i.line)).toEqual([2, 3, 4, 5, 6, 8]);
      expect(plan.issues[0]!.problem).toMatch(/whole number/);
      expect(plan.issues[5]!.problem).toMatch(/also on line 7/);
    });

    it("needs a counted column and an identifier; unchanged counts are skipped", () => {
      expect(planCountUpload("sku,qty\nTH-1,1", scope, none).issues[0]!.problem).toMatch(/counted/);
      expect(planCountUpload("category,counted\nFlower,1", scope, none).issues[0]!.problem).toMatch(
        /sku/,
      );
      expect(planCountUpload("", scope, none).issues[0]!.problem).toMatch(/empty/);
      const plan = planCountUpload("sku,counted\nTH-1,5", scope, new Map([["a", 5]]));
      expect(plan.lines).toEqual([]);
      expect(plan.unchanged).toBe(1);
      expect(
        planCountUpload("sku,counted\nTH-1,6", scope, new Map([["a", 5]])).lines[0]!.previous,
      ).toBe(5);
    });

    it("two products with the same name need a SKU", () => {
      const twins = [...scope, row({ product_id: "e", name: "Blue Haze" })];
      expect(planCountUpload("name,counted\nBlue Haze,1", twins, none).issues[0]!.problem).toMatch(
        /Two products/,
      );
    });
  });
});
