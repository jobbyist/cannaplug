import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mapYocoExport,
  normaliseRand,
  parseCsv,
  slugify,
  summariseImport,
} from "@/lib/catalogue-import";

const csv = readFileSync(new URL("./fixtures/yoco-products-sample.csv", import.meta.url), "utf8");

describe("Yoco catalogue import mapping", () => {
  const parsed = mapYocoExport(parseCsv(csv));
  const bySku = Object.fromEntries(parsed.rows.map((r) => [r.sku, r]));

  it("skips Excel's sep= line and reads quoted rand values", () => {
    expect(parseCsv('sep=,\na,b\n"1,5",x\n')).toEqual([
      ["a", "b"],
      ["1,5", "x"],
    ]);
    expect(bySku["ACC-RN"]!.price).toBe("1250.00");
    expect(bySku["ACC-RN"]!.cost).toBe("60.00");
  });
  it("maps categories, overrides the two blank ones and marks Lounge in-store only", () => {
    expect(bySku["PR-TS"]!.category).toBe("Pre-rolls");
    expect(bySku["VP-1"]!.category).toBe("Vapes");
    expect(bySku["DB-1"]!.category).toBe("Concentrates");
    expect(bySku["3CT001"]!.category).toBe("Edibles");
    expect(bySku["RFJO001"]!.category).toBe("Drinks");
    expect(bySku["LNG-1"]).toMatchObject({
      category: "Lounge",
      sell_online: false,
      track_stock: false,
      opening_qty: 0,
    });
  });
  it("uses Default Quantity as opening stock and detects weighed products", () => {
    expect(bySku["TS-WB"]).toMatchObject({ opening_qty: 26, sold_by_weight: true, unit: "g" });
    expect(bySku["PR-TS"]!.opening_qty).toBe(49);
    expect(bySku["TF(001"]!.opening_qty).toBe(0);
  });
  it("keeps SKUs verbatim and re-slugs renamed products from their name", () => {
    expect(bySku["TF(001"]!.slug).toBe("test-flower-greenhouse");
    expect(bySku["ACC-RN"]!.slug).toBe("renamed-product");
    expect(slugify("King’s Cherry (Greendoor)")).toBe("kings-cherry-greendoor");
    expect(slugify("FECO Cream - 125mg CBD & 375mg THC")).toBe(
      "feco-cream-125mg-cbd-and-375mg-thc",
    );
  });
  it("reports bad rows instead of guessing", () => {
    expect(parsed.issues.map((i) => i.problem)).toEqual([
      "Price is not a number",
      'Unknown category "Gadgets"',
      "Duplicate SKU PR-TS",
    ]);
    expect(summariseImport(parsed)).toMatchObject({
      products: 9,
      stocked: 5,
      weighed: 2,
      inStoreOnly: 1,
      issues: 3,
    });
  });
  it("normalises rand formats", () => {
    expect(normaliseRand("R1 250,00")).toBe("1250.00");
    expect(normaliseRand("1,250.00")).toBe("1250.00");
    expect(normaliseRand("1.250,50")).toBe("1250.50");
    expect(normaliseRand("35")).toBe("35.00");
    expect(normaliseRand("free")).toBeNull();
  });
  it("refuses a file that is not a Yoco export", () => {
    expect(mapYocoExport(parseCsv("a,b\n1,2")).issues[0]!.problem).toMatch(/not a Yoco/);
  });
});
