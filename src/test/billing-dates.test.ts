import { describe, expect, it } from "vitest";
import { daysUntil, formatMoney, isPaidStatus, nextBillingDate, todaySast } from "@/lib/billing";

const shopify = { recur_kind: "every_days" as const, recur_n: 30, anchor_date: "2026-10-30" };

describe("next billing date", () => {
  it("Shopify: first bill is 30 October 2026, then every 30 days (Nov 29, Dec 29, Jan 28, Feb 27, Mar 29)", () => {
    expect(nextBillingDate(shopify, "2026-10-28")).toBe("2026-10-30");
    expect(nextBillingDate(shopify, "2026-10-30")).toBe("2026-10-30");
    expect(nextBillingDate(shopify, "2026-10-31")).toBe("2026-11-29");
    expect(nextBillingDate(shopify, "2026-11-30")).toBe("2026-12-29");
    expect(nextBillingDate(shopify, "2026-12-30")).toBe("2027-01-28");
    expect(nextBillingDate(shopify, "2027-01-29")).toBe("2027-02-27");
    expect(nextBillingDate(shopify, "2027-02-28")).toBe("2027-03-29");
  });
  it("monthly on the 27th, clamped in a short month", () => {
    const m = { recur_kind: "monthly" as const, recur_n: null, anchor_date: "2026-10-27" };
    expect(nextBillingDate(m, "2026-10-28")).toBe("2026-11-27");
    expect(nextBillingDate(m, "2026-11-27")).toBe("2026-11-27");
    expect(nextBillingDate(m, "2026-12-28")).toBe("2027-01-27");
    const eom = { recur_kind: "monthly" as const, recur_n: null, anchor_date: "2026-01-31" };
    expect(nextBillingDate(eom, "2026-02-01")).toBe("2026-02-28");
    expect(nextBillingDate(eom, "2028-02-01")).toBe("2028-02-29");
  });
  it("yearly from 27 September 2027", () => {
    const y = { recur_kind: "yearly" as const, recur_n: null, anchor_date: "2027-09-27" };
    expect(nextBillingDate(y, "2026-10-28")).toBe("2027-09-27");
    expect(nextBillingDate(y, "2027-09-28")).toBe("2028-09-27");
    const leap = { recur_kind: "yearly" as const, recur_n: null, anchor_date: "2028-02-29" };
    expect(nextBillingDate(leap, "2029-01-01")).toBe("2029-02-28");
  });
  it("no rule, no date", () => {
    expect(
      nextBillingDate({ recur_kind: null, recur_n: null, anchor_date: null }, "2026-10-28"),
    ).toBeNull();
    expect(
      nextBillingDate(
        { recur_kind: "every_days", recur_n: null, anchor_date: "2026-10-30" },
        "2026-10-28",
      ),
    ).toBeNull();
  });
  it("counts days and reads South African time", () => {
    expect(daysUntil("2026-10-30", "2026-10-28")).toBe(2);
    expect(daysUntil("2026-10-29", "2026-10-28")).toBe(1);
    // 22:30 UTC on the 28th is already the 29th in South Africa
    expect(todaySast(new Date("2026-10-28T22:30:00Z"))).toBe("2026-10-29");
    expect(todaySast(new Date("2026-10-28T21:30:00Z"))).toBe("2026-10-28");
  });
  it("formats money and paid statuses", () => {
    expect(formatMoney(18000, "ZAR")).toBe("R180.00");
    expect(formatMoney(2500, "USD")).toBe("$25.00");
    expect(formatMoney(null, "ZAR")).toBe("");
    expect(isPaidStatus("COMPLETE") && isPaidStatus("COMPLETED")).toBe(true);
    expect(isPaidStatus("REFUNDED")).toBe(false);
  });
});
