import { describe, expect, it } from "vitest";
import { looseKey, rewardCoversProduct, rewardGradeOf } from "@/lib/rewards-logic";
import { canonicalCategory } from "@/lib/catalogue-taxonomy";

const indoor = { categories: ["Pre-rolls", "Flower"], grade: "Entry Indoor" };
const greenhouse = { categories: ["Pre-rolls", "Flower"], grade: "Greenhouse" };

describe("reward coverage (Purple Champagne: 'Prerolls', no grade in the name)", () => {
  it("covers a product graded by its Subcategory even when its category is spelled 'Prerolls'", () => {
    const p = { name: "Purple Champagne", category: "Prerolls", subcategory: "Entry Indoor" };
    expect(rewardCoversProduct(indoor, p)).toBe(true);
    expect(rewardCoversProduct(greenhouse, p)).toBe(false);
  });
  it("still reads the bracket in the name when no Subcategory is set", () => {
    expect(rewardGradeOf({ name: "Blue Gelato (Greenhouse)" })).toBe("greenhouse");
    expect(
      rewardCoversProduct(greenhouse, { name: "Blue Gelato (Greenhouse)", category: "Flower" }),
    ).toBe(true);
  });
  it("the Subcategory wins over the bracket", () => {
    expect(rewardGradeOf({ name: "Sour OG (Greenhouse)", subcategory: "Top Shelf" })).toBe(
      "top shelf",
    );
  });
  it("does not cover ungraded products, other categories or other grades", () => {
    expect(rewardCoversProduct(indoor, { name: "Moonstick", category: "Pre-rolls" })).toBe(false);
    expect(
      rewardCoversProduct(greenhouse, { name: "Gummies (Greenhouse)", category: "Edibles" }),
    ).toBe(false);
    expect(rewardCoversProduct(indoor, { name: "Zaza (Top Shelf)", category: "Flower" })).toBe(
      false,
    );
  });
  it("compares categories by letters and digits only", () => {
    expect(looseKey("Pre-Rolls")).toBe(looseKey("pre rolls"));
    expect(looseKey("Prerolls")).toBe("prerolls");
  });
});

describe("canonicalCategory", () => {
  it("saves the shop's spelling for punctuation and spacing variants", () => {
    for (const v of ["Prerolls", "pre rolls", "PRE-ROLLS", " Pre-rolls "])
      expect(canonicalCategory(v)).toBe("Pre-rolls");
    expect(canonicalCategory("flower")).toBe("Flower");
  });
  it("keeps an unknown category as typed (cleaned)", () => {
    expect(canonicalCategory("  Merch  Items ")).toBe("Merch Items");
    expect(canonicalCategory("")).toBeNull();
  });
});
