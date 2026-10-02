import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildSystemPrompt } from "./chat-prompt";
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
});

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

export function chatDeps(): ChatDeps {
  return {
    quotaDb: supabaseQuotaDb(),
    quota: quotaConfig(process.env),
    fetch: async (url, init) => {
      const r = await fetch(url, init);
      return { ok: r.ok, status: r.status, text: () => r.text() };
    },
    geminiKey: process.env["GEMINI_API_KEY"]?.trim() || null,
    buildPrompt: async () =>
      buildSystemPrompt(await dynamicFacts().catch(() => ({ menu: "", tiers: "" }))),
    warn: (m, e) => console.warn(`[chat] ${m}`, e instanceof Error ? e.message : e),
  };
}
