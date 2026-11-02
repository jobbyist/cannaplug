import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin Loyalty tab, by staff role, above the database: the sidebar shows the tab to every staff role, and the
 * real server gate (assertRole in admin-data.server) lets budtenders, managers and admins redeem while refusing a
 * customer before any database call. The database checks are in src/test/db/loyalty-staff-roles.test.ts.
 */
const db = vi.hoisted(() => ({
  roles: [] as { role: string }[],
  rpc: vi.fn(),
  posCompleteSale: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const roles = {
    select: () => roles,
    eq: () => roles,
    order: () => roles,
    limit: async () => ({ data: db.roles, error: null }),
  };
  return { supabaseAdmin: { from: () => roles, rpc: db.rpc } };
});
vi.mock("@/lib/commerce-suspension.server", () => ({ assertPosOpen: vi.fn(async () => {}) }));
vi.mock("@/lib/pos-data.server", () => ({
  friendlyPosError: (e: unknown) => e,
  getPosCustomerRewards: vi.fn(),
  posCompleteSale: db.posCompleteSale,
}));

import { canSee } from "@/lib/admin-nav";
import {
  recordPlugBackReturn,
  redeemPlugBack,
  redeemPointsReward,
} from "@/lib/loyalty-desk.server";

const ids = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  customerId: "00000000-0000-4000-8000-000000000002",
  productId: "00000000-0000-4000-8000-000000000003",
};
const staff = "00000000-0000-4000-8000-0000000000aa";

beforeEach(() => {
  db.rpc.mockReset().mockResolvedValue({ data: { ok: true }, error: null });
  db.posCompleteSale.mockReset().mockResolvedValue({ sale_id: "s", total: 0 });
});

describe("Loyalty tab for every staff role", () => {
  it.each(["budtender", "manager", "admin"] as const)("%s sees the Loyalty tab", (role) => {
    expect(canSee(role, "loyalty")).toBe(true);
  });

  it("a signed-in non-staff account does not", () => {
    expect(canSee(null, "loyalty")).toBe(false);
  });

  it.each(["budtender", "manager", "admin"])(
    "%s passes the server gate for points rewards and Plug Back",
    async (role) => {
      db.roles = [{ role }];
      await expect(
        redeemPointsReward(staff, { ...ids, rewardCode: "greenhouse_free", key: "key-12345" }),
      ).resolves.toMatchObject({ total: 0 });
      await expect(
        recordPlugBackReturn(staff, { customerId: ids.customerId, tubes: 10, key: "key-23456" }),
      ).resolves.toBeTruthy();
      await expect(redeemPlugBack(staff, { ...ids, key: "key-34567" })).resolves.toBeTruthy();
      // the actor is the signed-in staff member, never something the browser chose
      expect(db.posCompleteSale).toHaveBeenCalledWith(staff, expect.anything());
      expect(db.rpc).toHaveBeenCalledWith(
        "plug_back_redeem",
        expect.objectContaining({ p_actor: staff }),
      );
    },
  );

  it("a customer account is refused before any database call", async () => {
    db.roles = [{ role: "customer" }];
    await expect(
      redeemPointsReward(staff, { ...ids, rewardCode: "greenhouse_free", key: "key-12345" }),
    ).rejects.toThrow(/^Forbidden/);
    await expect(
      recordPlugBackReturn(staff, { customerId: ids.customerId, tubes: 10, key: "key-23456" }),
    ).rejects.toThrow(/^Forbidden/);
    await expect(redeemPlugBack(staff, { ...ids, key: "key-34567" })).rejects.toThrow(/^Forbidden/);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.posCompleteSale).not.toHaveBeenCalled();
  });
});
