import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EARN_RAND_PER_POINT,
  REFERRAL_MIN_SPEND,
  REFERRAL_POINTS,
  REWARD_TIERS,
  nextReward,
  normaliseUsername,
  referralFromSearch,
  referralLink,
  usernameProblem,
} from "@/lib/rewards-logic";
import {
  cartSummary,
  gradeOf,
  rewardCovers,
  type CatalogItem,
} from "@/components/admin/pos/pos-logic";

const sql = readFileSync("supabase/migrations/20261029006000_rewards_referrals.sql", "utf8");

describe("rewards numbers match the migration", () => {
  it("earn rate, referral points and minimum spend", () => {
    expect(EARN_RAND_PER_POINT).toBe(50);
    expect(sql).toMatch(/earn_rand_per_point[\s\S]{0,200}50/);
    expect(REFERRAL_POINTS).toBe(1);
    expect(REFERRAL_MIN_SPEND).toBe(50);
  });
  it("reward costs", () => {
    expect(REWARD_TIERS.map((t) => [t.code, t.points])).toEqual([
      ["greenhouse_free", 5],
      ["indoor_free", 10],
    ]);
    for (const t of REWARD_TIERS) expect(sql).toContain(`'${t.code}'`);
  });
});

describe("usernames", () => {
  it.each([
    ["", "Choose a username."],
    ["ab", /3 to 20/],
    ["has space", /3 to 20/],
    ["x".repeat(21), /3 to 20/],
    ["Admin", /not available/],
  ])("rejects %j", (v, msg) => {
    expect(usernameProblem(v)).toMatch(msg as RegExp);
  });
  it("accepts a good name, case-insensitively", () => {
    expect(usernameProblem("Thandi_99")).toBeNull();
    expect(normaliseUsername("  Thandi_99 ")).toBe("thandi_99");
  });
});

describe("referral links", () => {
  it("builds a sign-up link from the username", () => {
    expect(referralLink("https://cannaplug012.co.za/", "Thandi")).toBe(
      "https://cannaplug012.co.za/account?ref=thandi",
    );
  });
  it("reads ?ref= and ignores junk", () => {
    expect(referralFromSearch("?ref=Thandi")).toBe("thandi");
    expect(referralFromSearch("?ref=a")).toBe("");
    expect(referralFromSearch("")).toBe("");
  });
});

describe("next reward", () => {
  it("shows points to go, then null once everything is claimable", () => {
    expect(nextReward(3)).toEqual({ name: REWARD_TIERS[0]!.name, pointsToGo: 2 });
    expect(nextReward(5)?.pointsToGo).toBe(5);
    expect(nextReward(10)).toBeNull();
  });
});

describe("till rewards", () => {
  const item = (name: string, price: number): CatalogItem =>
    ({ id: name, name, category: "Pre-rolls", price_rand: price, available: 9 }) as CatalogItem;
  const offer = {
    code: "greenhouse_free",
    name: "x",
    points_cost: 5,
    grade: "Greenhouse",
    categories: ["Pre-rolls", "Flower"],
  };
  it("reads the grade from the end of the name", () => {
    expect(gradeOf("Orange Road Stick (Greenhouse)")).toBe("greenhouse");
    expect(gradeOf("Plain name")).toBeNull();
  });
  it("covers only matching grade and category", () => {
    expect(rewardCovers(offer, item("A (Greenhouse)", 60))).toBe(true);
    expect(rewardCovers(offer, item("A (Entry Indoor)", 60))).toBe(false);
    expect(rewardCovers({ ...offer, categories: ["Flower"] }, item("A (Greenhouse)", 60))).toBe(
      false,
    );
  });
  it("a reward makes one unit free and counts as no manual discount", () => {
    const product = item("A (Greenhouse)", 60);
    const s = cartSummary([{ product, quantity: 2, reward: "greenhouse_free" }], null, false);
    expect(s.rewardDiscountCents).toBe(6000);
    expect(s.totalCents).toBe(6000);
    expect(s.hasManualDiscount).toBe(false);
  });
});
