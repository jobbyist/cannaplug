import { describe, expect, it } from "vitest";
import { countCsv, countableProducts, findProducts, varianceSummary } from "@/lib/stock-take-logic";
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
});
