import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildSystemPrompt, memberContextLines } from "./chat-prompt";
import { chatModelFromEnv } from "./gemini";
import type { ChatDeps } from "./chat-service";
import type { QuotaDb } from "./quota";
import { quotaConfig } from "./quota";

export const supabaseQuotaDb = (): QuotaDb => ({
  async take(bucket, limit, ttlSeconds) {
    const { data, error } = await supabaseAdmin.rpc("ai_quota_take", {
      p_bucket: bucket,
      p_limit: limit,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new Error(error.message);
    return data === true;
  },
  async count(bucket) {
    const { data } = await supabaseAdmin
      .from("ai_usage_counters")
      .select("count")
      .eq("bucket", bucket)
      .maybeSingle();
    return data?.count ?? 0;
  },
});

/**
 * The member's own summary for the assistant: latest order (number, status, when) and points balance. Read
 * server-side with the service role, column by column — never ID, date of birth, address, phone or clinical data.
 */
export async function memberContext(userId: string) {
  const [order, loyalty, profile] = await Promise.all([
    supabaseAdmin
      .from("orders")
      .select("order_number,status,created_at,payment_method,delivery_method")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("loyalty_accounts")
      .select("points_balance,lifetime_points")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
  ]);
  return {
    firstName: (profile.data?.full_name ?? "").trim().split(/\s+/)[0] || null,
    latestOrder: order.data
      ? {
          number: order.data.order_number,
          status: order.data.status,
          placedAt: order.data.created_at,
          paymentMethod: order.data.payment_method,
          deliveryMethod: order.data.delivery_method,
        }
      : null,
    points: loyalty.data
      ? { balance: loyalty.data.points_balance, lifetime: loyalty.data.lifetime_points }
      : null,
  };
}

async function dynamicFacts() {
  const [products, tiers] = await Promise.all([
    supabaseAdmin
      .from("products")
      .select("name, category, subcategory, price_rand, unit, strain_type")
      .eq("is_active", true)
      .order("category")
      .limit(120),
    supabaseAdmin.from("loyalty_tiers").select("name, min_lifetime_points").order("sort_order"),
  ]);
  const lines = (products.data ?? []).map(
    (p) =>
      `${p.name} (${p.category}${p.subcategory ? " / " + p.subcategory : ""}${p.strain_type ? ", " + p.strain_type : ""}) R${p.price_rand}${p.unit ? " per " + p.unit : ""}`,
  );
  return {
    menu: lines.length
      ? `Current menu (prices in South African Rand, shown at checkout):\n${lines.join("\n")}`
      : "",
    tiers: (tiers.data ?? [])
      .map((t) => `${t.name} from ${t.min_lifetime_points} points`)
      .join(", "),
  };
}

/** What a signed-in member has left today. */
export async function chatAllowance(userId: string) {
  const { memberAllowance } = await import("./quota");
  return memberAllowance(supabaseQuotaDb(), quotaConfig(process.env), userId);
}

export function chatDeps(): ChatDeps {
  return {
    quotaDb: supabaseQuotaDb(),
    quota: quotaConfig(process.env),
    fetch: async (url, init) => {
      const r = await fetch(url, init);
      return { ok: r.ok, status: r.status, text: () => r.text() };
    },
    geminiKey: process.env["GEMINI_API_KEY"]?.trim() || null,
    model: chatModelFromEnv(process.env),
    buildPrompt: async (userId) => {
      const [facts, member] = await Promise.all([
        dynamicFacts().catch(() => ({ menu: "", tiers: "" })),
        memberContext(userId).catch(() => null),
      ]);
      return buildSystemPrompt({ ...facts, member: member ? memberContextLines(member) : "" });
    },
    warn: (m, e) => console.warn(`[chat] ${m}`, e instanceof Error ? e.message : e),
    info: (m) => console.info(`[chat] ${m}`),
  };
}
