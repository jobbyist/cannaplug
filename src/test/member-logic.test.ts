import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  describeLoyaltyTxn,
  friendlyMemberError,
  maxRedeemablePoints,
  pointsValueRand,
  rulesFromRows,
  statusLabel,
  summariseReorder,
  tierProgress,
  type ReorderCheck,
} from "@/lib/member-logic";

const tiers = [
  { code: "seed", name: "Seed", min_lifetime_points: 0, perks: [] },
  { code: "sprout", name: "Sprout", min_lifetime_points: 500, perks: [] },
  { code: "bloom", name: "Bloom", min_lifetime_points: 2000, perks: [] },
];

describe("tier progress", () => {
  it("is driven by lifetime points", () => {
    expect(tierProgress(0, tiers)).toMatchObject({
      current: { code: "seed" },
      next: { code: "sprout" },
      pointsToNext: 500,
      percent: 0,
    });
    expect(tierProgress(750, tiers)).toMatchObject({
      current: { code: "sprout" },
      next: { code: "bloom" },
      pointsToNext: 1250,
    });
    expect(tierProgress(500, tiers).current?.code).toBe("sprout");
  });
  it("reports the top tier as complete", () => {
    expect(tierProgress(9999, tiers)).toMatchObject({
      current: { code: "bloom" },
      next: null,
      percent: 100,
    });
  });
});

describe("redemption preview (display only; the database is authoritative)", () => {
  it("is capped by the order share, the balance and the minimum", () => {
    // R100 order, 50% cap => R50 => 500 points at R0.10
    expect(maxRedeemablePoints(100, 10_000, DEFAULT_RULES)).toBe(500);
    expect(maxRedeemablePoints(100, 300, DEFAULT_RULES)).toBe(300);
    expect(maxRedeemablePoints(100, 99, DEFAULT_RULES)).toBe(0); // under the 100-point minimum
    expect(maxRedeemablePoints(100, -50, DEFAULT_RULES)).toBe(0);
    expect(maxRedeemablePoints(0, 1000, DEFAULT_RULES)).toBe(0);
  });
  it("values points in rand", () => {
    expect(pointsValueRand(250, DEFAULT_RULES)).toBe(25);
  });
  it("reads live rules and falls back safely on bad values", () => {
    expect(
      rulesFromRows([
        { code: "earn_rand_per_point", value: "20" },
        { code: "redeem_min_points", value: 0 },
      ]),
    ).toMatchObject({
      earnRandPerPoint: 20,
      minRedeemPoints: DEFAULT_RULES.minRedeemPoints,
      maxRedeemPct: 50,
    });
  });
});

describe("reorder summary", () => {
  const base: ReorderCheck = {
    order_id: "o",
    order_number: "CP-1",
    orderable: true,
    current_total: 200,
    lines: [
      {
        product_id: "p",
        name: "Blue Gelato",
        quantity: 2,
        previous_price: 90,
        current_price: 100,
        available: 5,
        status: "price_changed",
      },
    ],
  };
  it("flags price changes but still allows the reorder", () => {
    const s = summariseReorder(base);
    expect(s.canReorder).toBe(true);
    expect(s.repriced).toHaveLength(1);
    expect(s.message).toMatch(/prices have changed/i);
  });
  it("blocks when anything is unavailable or short", () => {
    const s = summariseReorder({
      ...base,
      orderable: false,
      current_total: null,
      lines: [{ ...base.lines[0]!, status: "insufficient_stock", available: 1 }],
    });
    expect(s.canReorder).toBe(false);
    expect(s.message).toContain("Blue Gelato");
  });
});

describe("friendly errors", () => {
  it("maps database codes to safe messages and keeps useful numbers", () => {
    expect(
      friendlyMemberError(new Error("insufficient_points: balance is 40 points")).message,
    ).toBe("You do not have enough points");
    expect(
      friendlyMemberError({
        message: "exceeds_order_limit: at most 500 points can be applied to this order",
      }).message,
    ).toContain("(at most 500 points");
    expect(friendlyMemberError(new Error("order_not_found")).message).toBe(
      "That order could not be found",
    );
  });
  it("never leaks raw database errors", () => {
    expect(
      friendlyMemberError(new Error('relation "x" does not exist at character 14')).message,
    ).toBe("The action could not be completed. Please retry.");
    expect(
      friendlyMemberError(new Error("new row violates row-level security policy")).message,
    ).toBe("You do not have permission for this action");
  });
});

describe("labels", () => {
  it("labels statuses and ledger sources", () => {
    expect(statusLabel("out_for_delivery")).toBe("Out for delivery");
    expect(statusLabel("weird_state")).toBe("Weird state");
    expect(describeLoyaltyTxn("pos_sale")).toBe("Earned in store");
    expect(describeLoyaltyTxn("nope")).toBe("Points adjustment");
  });
});
