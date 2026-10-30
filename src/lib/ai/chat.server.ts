import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { INTRO_FEATURE } from "@/lib/ask-plug-access";
import { memberContextLines } from "./chat-prompt";
import type { ChatDeps } from "./chat-service";
import { liveCandidates, unavailableNames } from "@/lib/plug-stock.server";
import { plugModels } from "./plug-models";
import type { QuotaDb } from "./quota";
import { memberAllowance, quotaConfig } from "./quota";

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

async function loadTiers(): Promise<string> {
  const { data } = await supabaseAdmin
    .from("loyalty_tiers")
    .select("name, min_lifetime_points")
    .order("sort_order");
  return (data ?? []).map((t) => `${t.name} from ${t.min_lifetime_points} points`).join(", ");
}

export const plugConfigured = () => Boolean(process.env["GEMINI_API_KEY"]?.trim());

/**
 * What the storefront needs for this caller. Ask The Plug is open to everyone, so it is always available (the guided
 * quiz needs no AI and no Gemini key). Signed-in members also get what they have left today and the one-time launch
 * announcement; visitors get neither.
 */
export async function plugStatus(userId: string | null) {
  if (!userId) return { available: true, chat: plugConfigured(), allowance: null, intro: null };
  const seenRes = await supabaseAdmin.rpc("member_features_seen", { p_actor: userId });
  const seen = new Set<string>((seenRes.data as string[] | null) ?? []);
  const allowance = await memberAllowance(
    supabaseQuotaDb(),
    quotaConfig(process.env),
    userId,
  ).catch(() => null);
  // A read failure on the seen list must never pop the modal at every page load: show nothing instead.
  const intro = seenRes.error || seen.has(INTRO_FEATURE) ? null : ("full" as const);
  return { available: true, chat: plugConfigured(), allowance, intro };
}

export async function markFeatureSeen(
  userId: string,
  feature: string,
  action: "opened" | "dismissed",
  idempotencyKey: string,
) {
  const { error } = await supabaseAdmin.rpc("member_feature_mark_seen", {
    p_actor: userId,
    p_feature: feature,
    p_action: action,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw new Error(error.message);
  return { ok: true as const };
}

export function chatDeps(): ChatDeps {
  return {
    quotaDb: supabaseQuotaDb(),
    quota: quotaConfig(process.env),
    models: plugModels(process.env),
    fetch: async (url, init) => {
      const r = await fetch(url, init);
      return { ok: r.ok, status: r.status, text: () => r.text() };
    },
    geminiKey: process.env["GEMINI_API_KEY"]?.trim() || null,
    // Live on every message, no cache: the database applies the hard filters and the safety buffer (spec layers 1-2).
    loadCatalogue: async () => {
      const products = await liveCandidates();
      return { products, unavailableNames: await unavailableNames(products).catch(() => []) };
    },
    logReplaced: async () => {
      await supabaseAdmin.rpc("plug_match_log", {
        p_kind: "chat_reply_replaced",
        p_outcome: "replaced",
        p_answers: {},
        p_product_ids: [],
      });
    },
    loadContext: async (userId) => {
      const [tiers, member] = await Promise.all([
        loadTiers().catch(() => ""),
        userId ? memberContext(userId).catch(() => null) : Promise.resolve(null),
      ]);
      return { tiers, member: member ? memberContextLines(member) : "" };
    },
    warn: (m, e) => console.warn(`[ask-the-plug] ${m}`, e instanceof Error ? e.message : e),
    info: (m) => console.info(`[ask-the-plug] ${m}`),
  };
}
