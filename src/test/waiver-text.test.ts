import { describe, expect, it } from "vitest";
import { CONDITIONS, WAIVER_CLAUSES, conditionLabel, declineLabel } from "@/lib/waiver-text";

describe("waiver wording", () => {
  it("has clauses 5.1 to 5.9 in order", () => {
    expect(WAIVER_CLAUSES.map(([n]) => n)).toEqual([
      "5.1",
      "5.2",
      "5.3",
      "5.4",
      "5.5",
      "5.6",
      "5.7",
      "5.8",
      "5.9",
    ]);
  });
  it("labels every decline reason the database can return", () => {
    for (const r of [
      "under_18",
      "under_the_influence",
      "pregnant_or_breastfeeding",
      "staff_concern",
    ])
      expect(declineLabel(r)).not.toBe(r);
  });
  it("has a label for every condition the form offers", () => {
    for (const c of CONDITIONS) expect(conditionLabel(c.id)).toBe(c.label);
  });
});
