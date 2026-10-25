import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { PRODUCT_CATEGORIES } from "@/lib/product-csv";

/** Manager+: every category with its limit (null = no limit set). */
export async function listPurchaseLimits(userId: string) {
  const role = await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin
    .from("purchase_limits")
    .select("category,daily_max,enabled,updated_at");
  if (error) throw error;
  const byCat = new Map((data ?? []).map((r) => [r.category, r]));
  return {
    canEdit: role === "admin",
    limits: PRODUCT_CATEGORIES.map((category) => {
      const r = byCat.get(category);
      return {
        category,
        daily_max: r?.daily_max ?? null,
        enabled: r?.enabled ?? false,
        updated_at: r?.updated_at ?? null,
      };
    }),
  };
}

/** Admin: set one category's daily limit and switch it on or off (checked again in the database). */
export async function setPurchaseLimit(
  userId: string,
  category: string,
  dailyMax: number,
  enabled: boolean,
  key: string,
) {
  await assertRole(userId, "admin");
  const { data, error } = await supabaseAdmin.rpc("purchase_limit_set", {
    p_actor: userId,
    p_category: category,
    p_daily_max: dailyMax,
    p_enabled: enabled,
    p_idempotency_key: key,
  });
  if (error) throw error;
  return data as { category: string; daily_max: number; enabled: boolean };
}

/** Admin: unlock a member who used all their ID attempts, with a reason (audited in the database). */
export async function resetVerificationAttempts(
  userId: string,
  memberId: string,
  reason: string,
  key: string,
) {
  await assertRole(userId, "admin");
  const { data, error } = await supabaseAdmin.rpc("verification_reset_attempts", {
    p_actor: userId,
    p_member: memberId,
    p_reason: reason,
    p_idempotency_key: key,
  });
  if (error) throw error;
  return data as { member: string; attempt_count: number };
}
