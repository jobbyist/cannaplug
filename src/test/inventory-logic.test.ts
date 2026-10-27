import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  adjustmentPreview,
  adjustmentReasonText,
  filterInventory,
  inventoryCsv,
  stockStatus,
  suggestBatchCode,
  summarise,
} from "@/lib/inventory-logic";
import { row } from "./inventory-fixtures";

const now = new Date("2026-10-27T08:00:00Z");
describe("inventory logic", () => {
  it("classifies stock against the product's own alert level", () => {
    expect(stockStatus(row({ available: 0 }))).toBe("out");
    expect(stockStatus(row({ available: 5 }))).toBe("low");
    expect(stockStatus(row({ available: 6 }))).toBe("ok");
    expect(stockStatus(row({ available: 6, low_stock_threshold: 10 }))).toBe("low");
    expect(stockStatus(row({ available: 0, track_stock: false }))).toBe("untracked");
  });

  it("searches, filters by category and status, hides inactive and puts problems first", () => {
    const rows = [
      row({ name: "Zkittlez", available: 40 }),
      row({ name: "Amnesia", available: 0 }),
      row({ name: "Blue Dream", available: 3, sku: "BD-1" }),
      row({ name: "Rolling papers", category: "Accessories", available: 50 }),
      row({ name: "Old stock", is_active: false, available: 0 }),
      row({ name: "Gummies", category: "Edibles", next_expiry: "2026-11-10T00:00:00Z" }),
    ];
    const names = (f = {}) =>
      filterInventory(rows, { ...DEFAULT_FILTERS, ...f }, now).map((r) => r.name);
    expect(names()).toEqual(["Amnesia", "Blue Dream", "Gummies", "Zkittlez", "Rolling papers"]);
    expect(names({ q: "bd-1" })).toEqual(["Blue Dream"]);
    expect(names({ category: "Accessories" })).toEqual(["Rolling papers"]);
    expect(names({ status: "low" })).toEqual(["Blue Dream"]);
    expect(names({ status: "expiring" })).toEqual(["Gummies"]);
    expect(names({ showInactive: true, status: "out" })).toEqual(["Amnesia", "Old stock"]);
    expect(names({ sort: "available_desc" })[0]).toBe("Rolling papers");
  });

  it("summarises active, tracked products only", () => {
    const s = summarise(
      [
        row({ available: 0, on_hand: 2, held: 2 }),
        row({ available: 3, on_hand: 3, stock_value: 90 }),
        row({ is_active: false, available: 0 }),
        row({ track_stock: false, available: 0 }),
        row({ expired: 4 }),
      ],
      now,
    );
    expect(s).toMatchObject({
      products: 3,
      out: 1,
      low: 1,
      expired: 1,
      units: 15,
      held: 2,
      value: 90,
    });
    expect(summarise([row({})]).value).toBeNull();
  });

  it("previews adjustments and refuses going below zero or below held stock", () => {
    expect(adjustmentPreview({ mode: "remove", amount: 2, batchOnHand: 10, batchHeld: 0 })).toEqual(
      {
        delta: -2,
        after: 8,
        problem: null,
      },
    );
    expect(
      adjustmentPreview({ mode: "count", amount: 7, batchOnHand: 10, batchHeld: 0 }).delta,
    ).toBe(-3);
    expect(
      adjustmentPreview({ mode: "count", amount: 12, batchOnHand: 10, batchHeld: 0 }).delta,
    ).toBe(2);
    expect(
      adjustmentPreview({ mode: "count", amount: 10, batchOnHand: 10, batchHeld: 0 }).problem,
    ).toMatch(/Nothing to change/);
    expect(
      adjustmentPreview({ mode: "remove", amount: 11, batchOnHand: 10, batchHeld: 0 }).problem,
    ).toMatch(/only has 10/);
    expect(
      adjustmentPreview({ mode: "count", amount: 1, batchOnHand: 10, batchHeld: 3 }).problem,
    ).toMatch(/held for online orders/);
  });

  it("writes a readable ledger reason, and 'Other' needs a note", () => {
    expect(adjustmentReasonText("damaged", "")).toBe("Damaged");
    expect(adjustmentReasonText("count", "Friday count")).toBe(
      "Stock count correction: Friday count",
    );
    expect(adjustmentReasonText("other", "ab")).toBeNull();
    expect(adjustmentReasonText("other", "Moved to display")).toBe("Moved to display");
  });

  it("suggests batch codes from the SKU or the name", () => {
    expect(suggestBatchCode({ sku: "th-01", name: "Thai Haze" }, now)).toBe("TH01-271026");
    expect(suggestBatchCode({ sku: null, name: "Blue Dream Pre-roll" }, now)).toBe("BDP-271026");
  });

  it("exports a stock sheet without cost data", () => {
    const csv = inventoryCsv([row({ name: 'Kush, "OG"', stock_value: 500 })]);
    expect(csv.split("\n")[0]).toContain("counted");
    expect(csv).toContain('"Kush, ""OG"""');
    expect(csv).not.toContain("500");
  });
});
