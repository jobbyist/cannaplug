import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalCategory,
  canonicalSubcategory,
  gradeFromName,
  normKey,
  orderBy,
} from "@/lib/catalogue-taxonomy";

describe("catalogue taxonomy", () => {
  it("matches names without regard to case, spaces or accents", () => {
    expect(normKey("  TOP   Shelf ")).toBe("top shelf");
    expect(normKey("Crème")).toBe("creme");
    expect(canonicalCategory("pre-ROLLS")).toBe("Pre-rolls");
    expect(canonicalCategory("Lounge")).toBe("Lounge");
    expect(canonicalCategory("   ")).toBeNull();
  });

  it("saves a grade in the shop's spelling, and anything else tidied", () => {
    expect(canonicalSubcategory("Flower", "top shelf")).toBe("Top Shelf");
    expect(canonicalSubcategory("flower", " PREMIUM  indoor ")).toBe("Premium Indoor");
    expect(canonicalSubcategory("Pre-rolls", "greendoor 2-in-1")).toBe("Greendoor 2-in-1");
    expect(canonicalSubcategory("Edibles", "  gummies  &  sweets ")).toBe("gummies & sweets");
    expect(canonicalSubcategory("Flower", "   ")).toBeNull();
    expect(canonicalSubcategory("Flower", null)).toBeNull();
  });

  it("reads the grade from the end of a product name; Entry Indoor is the Premium Indoor tier", () => {
    const cases: [string, string | null][] = [
      ["Purple Fritter (Greenhouse)", "Greenhouse"],
      ["Mandarin Cookies (Greendoor)", "Greendoor"],
      ["Apple Strudel (Entry Indoor)", "Premium Indoor"],
      ["Apple Strudel (Premium Indoor)", "Premium Indoor"],
      ["Zaza (Top Shelf)", "Top Shelf"],
      ["Astro Grape (Outdoor)", "Outdoor"],
      ["Runtz Infused Stick (Greendoor 2-in-1)", "Greendoor 2-in-1"],
      ["Wedding Cake x Garlic Breath (Top Shelf)", "Top Shelf"],
      ["Mokum’s Tulip (Greenhouse)  ", "Greenhouse"],
      ["Moonstick", null],
      ["Indoor Cannagar", null],
      ["Lighter (Blue)", null],
      ["(Top Shelf) Zaza", null],
    ];
    for (const [name, grade] of cases) expect(gradeFromName(name), name).toBe(grade);
  });

  it("the database back-fill reads the same grades as the code (one rule, written twice)", () => {
    const sql = readFileSync(
      new URL(
        "../../supabase/migrations/20261029004000_product_subcategories.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const fill = sql.slice(sql.indexOf("-- 2."), sql.indexOf("-- 3."));
    const pairs = [...fill.matchAll(/WHEN '([^']+)' THEN '([^']+)'/g)].map((m) => [m[1]!, m[2]!]);
    expect(pairs.length).toBe(7);
    for (const [bracket, grade] of pairs)
      expect(gradeFromName(`Anything (${bracket})`), bracket).toBe(grade);
  });

  it("orders known names first, the rest A to Z, and drops repeats", () => {
    expect(
      orderBy(["Top Shelf", "zebra", "Outdoor", "apple", "top shelf"], ["Outdoor", "Top Shelf"]),
    ).toEqual(["Outdoor", "Top Shelf", "apple", "zebra"]);
  });
});
