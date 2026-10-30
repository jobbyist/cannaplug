import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { assertPosOpen } from "@/lib/commerce-suspension.server";
import { friendlyPosError, getPosCustomerRewards, posCompleteSale } from "@/lib/pos-data.server";
import type { Json } from "@/integrations/supabase/types";

/**
 * The Loyalty tab: staff give a member's points rewards and Plug Back free pre-rolls in the admin dashboard.
 * Everything is decided in the database (points, tubes, eligibility, price, stock); the browser sends ids only.
 * Both kinds of reward are R0 till sales, so each needs the staff member's own open till session.
 */

export type PlugBackSummary = {
  tubes: number;
  tubes_per_reward: number;
  rewards_available: number;
  tubes_to_next: number;
  lifetime_tubes: number;
  rewards_given: number;
  products: { id: string; name: string; price_rand: number }[];
  history: { kind: "return" | "redeem" | "redeem_void"; tubes: number; at: string }[];
};

export type RewardProduct = {
  id: string;
  name: string;
  category: string;
  price_rand: number;
  unit: string;
  available: number;
};

export type LoyaltyDesk = {
  till: { sessionId: string; drawerName: string } | null;
  points: number;
  rewards: {
    code: string;
    name: string;
    points_cost: number;
    grade: string;
    products: RewardProduct[];
  }[];
  plugBack: PlugBackSummary;
};

/** The grade is the last bracket in the product name, e.g. "Blue Gelato (Greenhouse)". Same rule as the database. */
export const gradeOf = (name: string) =>
  /\(([^)]*)\)\s*$/.exec(name)?.[1]?.trim().toLowerCase() ?? null;

async function myTill(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("pos_sessions")
    .select("id,cash_drawers(name)")
    .eq("status", "open")
    .eq("opened_by", userId)
    .limit(1);
  if (error) throw friendlyPosError(error);
  const row = data?.[0] as
    { id: string; cash_drawers: { name: string } | { name: string }[] | null } | undefined;
  if (!row) return null;
  const drawer = Array.isArray(row.cash_drawers) ? row.cash_drawers[0] : row.cash_drawers;
  return { sessionId: row.id, drawerName: drawer?.name ?? "Till" };
}

export async function getLoyaltyDesk(userId: string, customerId: string): Promise<LoyaltyDesk> {
  await assertRole(userId, "budtender");
  const [till, points, plug] = await Promise.all([
    myTill(userId),
    getPosCustomerRewards(userId, customerId),
    supabaseAdmin.rpc("plug_back_summary", { p_actor: userId, p_customer: customerId }),
  ]);
  if (plug.error) throw friendlyPosError(plug.error);

  const categories = [...new Set(points.rewards.flatMap((r) => r.categories))];
  const [prod, avail] = await Promise.all([
    supabaseAdmin
      .from("products")
      .select("id,name,category,price_rand,unit")
      .eq("is_active", true)
      .in("category", categories.length ? categories : ["-"])
      .order("name")
      .limit(500),
    supabaseAdmin.from("inventory_availability").select("product_id,available"),
  ]);
  if (prod.error) throw friendlyPosError(prod.error);
  if (avail.error) throw friendlyPosError(avail.error);
  const stock = new Map(
    (avail.data ?? []).map((a) => [a.product_id as string, Number(a.available)]),
  );

  return {
    till,
    points: points.points,
    rewards: points.rewards.map((r) => ({
      code: r.code,
      name: r.name,
      points_cost: r.points_cost,
      grade: r.grade,
      products: (prod.data ?? [])
        .filter(
          (p) => r.categories.includes(p.category) && gradeOf(p.name) === r.grade.toLowerCase(),
        )
        .map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          price_rand: Number(p.price_rand),
          unit: p.unit ?? "each",
          available: stock.get(p.id) ?? 0,
        }))
        .filter((p) => p.available > 0),
    })),
    plugBack: plug.data as unknown as PlugBackSummary,
  };
}

/** Points for a free product: one unit, R0 sale. The database checks the member, the points and the product. */
export async function redeemPointsReward(
  userId: string,
  input: {
    sessionId: string;
    customerId: string;
    productId: string;
    rewardCode: string;
    key: string;
  },
) {
  await assertRole(userId, "budtender");
  return posCompleteSale(userId, {
    sessionId: input.sessionId,
    items: [{ product_id: input.productId, quantity: 1, reward: input.rewardCode }],
    tenders: [],
    customerId: input.customerId,
    key: input.key,
  });
}

export async function recordPlugBackReturn(
  userId: string,
  input: { customerId: string; tubes: number; note?: string | undefined; key: string },
) {
  await assertRole(userId, "budtender");
  await assertPosOpen();
  const { data, error } = await supabaseAdmin.rpc("plug_back_record_return", {
    p_actor: userId,
    p_customer: input.customerId,
    p_tubes: input.tubes,
    p_note: input.note ?? "",
    p_idempotency_key: input.key,
  });
  if (error) throw friendlyPosError(error);
  return data as unknown as { customer_id: string; recorded: number; tubes: number };
}

export async function redeemPlugBack(
  userId: string,
  input: { sessionId: string; customerId: string; productId: string; key: string },
) {
  await assertRole(userId, "budtender");
  await assertPosOpen();
  const { data, error } = await supabaseAdmin.rpc("plug_back_redeem", {
    p_actor: userId,
    p_session_id: input.sessionId,
    p_customer: input.customerId,
    p_product: input.productId,
    p_idempotency_key: input.key,
  });
  if (error) throw friendlyPosError(error);
  return data as unknown as {
    sale_id: string;
    receipt_number: string;
    tubes_spent: number;
    tubes: number;
  } & Record<string, Json>;
}
