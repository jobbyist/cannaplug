import { describe, expect, it } from "vitest";
import {
  addQty,
  cleanQtyInput,
  formatQty,
  formatQtyUnit,
  isTenths,
  isWholeQty,
  lineCents,
  parseQty,
  qtyProblem,
  roundQty,
  subQty,
  sumQty,
  toTenths,
} from "@/lib/qty";

describe("decimal quantities (one decimal place)", () => {
  it("adds and subtracts exactly, where plain floats drift", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(addQty(0.1, 0.2)).toBe(0.3);
    expect(subQty(0.3, 0.1)).toBe(0.2);
    expect(sumQty([0.1, 0.1, 0.1])).toBe(0.3);
    expect(sumQty([27.4, 2.6, 0.1])).toBe(30.1);
    expect(roundQty(27.400000000000002)).toBe(27.4);
    expect(toTenths(27.4)).toBe(274);
  });

  it("knows what has at most one decimal and what is whole", () => {
    expect(isTenths(27.4)).toBe(true);
    expect(isTenths(0.1 + 0.2)).toBe(true);
    expect(isTenths(27.45)).toBe(false);
    expect(isTenths(Number.NaN)).toBe(false);
    expect(isWholeQty(27)).toBe(true);
    expect(isWholeQty(27.4)).toBe(false);
  });

  it("reads what staff type, with a point or a comma", () => {
    const w = { decimals: true };
    expect(parseQty("27", w)).toBe(27);
    expect(parseQty("27.4", w)).toBe(27.4);
    expect(parseQty("27,4", w)).toBe(27.4);
    expect(parseQty(" 27,4 ", w)).toBe(27.4);
    expect(parseQty(".5", w)).toBe(0.5);
    expect(parseQty("12.0", w)).toBe(12);
    expect(parseQty("0", w)).toBe(0);
    expect(parseQty("0", { decimals: true, allowZero: false })).toBeNull();
    expect(parseQty("27.45", w)).toBeNull();
    expect(parseQty("-3", w)).toBeNull();
    expect(parseQty("", w)).toBeNull();
    expect(parseQty("abc", w)).toBeNull();
    expect(parseQty("1e3", w)).toBeNull();
    expect(parseQty("2000000", w)).toBeNull();
    // products counted in whole units never take a decimal
    expect(parseQty("12", { decimals: false })).toBe(12);
    expect(parseQty("12.0", { decimals: false })).toBe(12);
    expect(parseQty("2.5", { decimals: false })).toBeNull();
    expect(parseQty("2,5", { decimals: false })).toBeNull();
  });

  it("explains in plain words what is wrong", () => {
    const w = { decimals: true };
    expect(qtyProblem("27.4", w)).toBeNull();
    expect(qtyProblem("", w)).toMatch(/Enter the quantity/);
    expect(qtyProblem("-1", w)).toMatch(/negative/);
    expect(qtyProblem("27.45", w)).toMatch(/one decimal/);
    expect(qtyProblem("2.5", { decimals: false })).toMatch(/whole units/);
    expect(qtyProblem("abc", w)).toMatch(/numbers only/);
    expect(qtyProblem("0", { decimals: true, allowZero: false })).toMatch(/more than 0/);
  });

  it("tidies typing: digits, one separator and one decimal digit", () => {
    expect(cleanQtyInput("27.45")).toBe("27.4");
    expect(cleanQtyInput("27,4")).toBe("27,4");
    expect(cleanQtyInput("2a7..4")).toBe("27.");
    expect(cleanQtyInput("abc")).toBe("");
    // a decimal for a whole-unit product is kept, so it can be refused with a reason instead of becoming 25
    expect(cleanQtyInput("2.5")).toBe("2.5");
    expect(parseQty(cleanQtyInput("2.5"), { decimals: false })).toBeNull();
    expect(qtyProblem(cleanQtyInput("2.5"), { decimals: false })).toMatch(/whole units/);
  });

  it("shows quantities like the rest of the app (comma decimal in South Africa)", () => {
    expect(formatQty(27.4)).toBe("27,4");
    expect(formatQty(27)).toBe("27");
    expect(formatQty(0.1 + 0.2)).toBe("0,3");
    expect(formatQtyUnit(27.4, true)).toBe("27,4 g");
    expect(formatQtyUnit(6, false)).toBe("6");
  });

  it("prices a line to the cent, half up, like the database", () => {
    expect(lineCents(24.55, 1.5)).toBe(3683); // 36.825 -> 36.83
    expect(lineCents(24.55, 2)).toBe(4910);
    expect(lineCents(24, 0.1)).toBe(240);
    expect(lineCents(24.55, 0.1)).toBe(246); // 2.455 -> 2.46
    expect(lineCents(19.99, 3)).toBe(5997);
    expect(lineCents(120, 1)).toBe(12000);
  });
});
