import { describe, expect, it } from "vitest";
import { fromLocalInput, saleProblem, toLocalInput } from "@/lib/sale-price";

const now = new Date("2026-10-27T08:00:00Z");

describe("sale price rules", () => {
  it("accepts a lower sale price with a future or no end date", () => {
    expect(saleProblem({ price: 100, sale: 80, endsAt: null, now })).toBeNull();
    expect(saleProblem({ price: 100, sale: 80, endsAt: "2026-10-28T08:00:00Z", now })).toBeNull();
    expect(saleProblem({ price: 100, sale: null, endsAt: null, now })).toBeNull();
  });
  it("refuses a sale price that is not lower, zero, an end date without a sale, or an end in the past", () => {
    expect(saleProblem({ price: 100, sale: 100, endsAt: null, now })).toMatch(
      /lower than the regular/,
    );
    expect(saleProblem({ price: 100, sale: 120, endsAt: null, now })).toMatch(
      /lower than the regular/,
    );
    expect(saleProblem({ price: 100, sale: 0, endsAt: null, now })).toMatch(/more than R0/);
    expect(saleProblem({ price: 100, sale: null, endsAt: "2026-10-28T08:00:00Z", now })).toMatch(
      /Add a sale price/,
    );
    expect(saleProblem({ price: 100, sale: 80, endsAt: "2026-10-27T07:59:00Z", now })).toMatch(
      /already passed/,
    );
  });
  it("round-trips the end date through the date picker without shifting it", () => {
    const iso = "2026-10-31T16:00:00.000Z";
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(toLocalInput(null)).toBe("");
    expect(fromLocalInput("")).toBeNull();
  });
});
