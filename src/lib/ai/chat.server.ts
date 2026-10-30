import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { listStoreProducts } from "@/lib/admin-data.server";
import { INTRO_FEATURE, PREVIEW_FEATURE, isVerifiedMember } from "@/lib/ask-plug-access";
import { isStaffAccount } from "@/lib/verification-data.server";
import { memberContextLines } from "./chat-prompt";
import type { ChatDeps } from "./chat-service";
import type { StoreProduct } from "./plug-catalogue";
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

/**
 * The shop's live listing, reused for up to a minute per server instance so a busy chat does not read the catalogue
 * on every message. A minute is short enough that a sold-out product stops being recommended almost at once (and
 * checkout re-checks stock and price anyway).
 */
const CATALOGUE_TTL_MS = 60_000;
let catalogueCache: { at: number; rows: StoreProduct[] } | null = null;
export async function liveCatalogue(now = Date.now()): Promise<StoreProduct[]> {
  if (catalogueCache && now - catalogueCache.at < CATALOGUE_TTL_MS) return catalogueCache.rows;
  const rows = (await listStoreProducts()) as StoreProduct[];
  catalogueCache = { at: now, rows };
  return rows;
}

/** Verified member (approved, unexpired ID) or staff. Read with the service role for the signed-in user only. */
export async function isPlugEligible(userId: string): Promise<boolean> {
  const [row, staff] = await Promise.all([
    supabaseAdmin
      .from("customer_verification")
      .select("status, document_expires_on")
      .eq("user_id", userId)
      .maybeSingle(),
    isStaffAccount(userId),
  ]);
  if (row.error) throw row.error;
  return isVerifiedMember(staff ? { staff_exempt: true } : row.data);
}

export const plugConfigured = () => Boolean(process.env["GEMINI_API_KEY"]?.trim());

/**
 * What the storefront needs to know for this member: whether to show the launcher, what they have left today, and
 * which announcement (if any) to show: the full intro once they are verified, or a one-time "verify to unlock"
 * preview before that.
 */
export async function plugStatus(userId: string) {
  if (!plugConfigured()) return { available: false, eligible: false, allowance: null, intro: null };
  const [eligible, seenRes] = await Promise.all([
    isPlugEligible(userId),
    supabaseAdmin.rpc("member_features_seen", { p_actor: userId }),
  ]);
  const seen = new Set<string>((seenRes.data as string[] | null) ?? []);
  const intro = eligible
    ? seen.has(INTRO_FEATURE)
      ? null
      : ("full" as const)
    : seen.has(INTRO_FEATURE) || seen.has(PREVIEW_FEATURE)
      ? null
      : ("preview" as const);
  const allowance = eligible
    ? await memberAllowance(supabaseQuotaDb(), quotaConfig(process.env), userId).catch(() => null)
    : null;
  // A read failure on the seen list must never pop the modal at every page load: show nothing instead.
  return { available: true, eligible, allowance, intro: seenRes.error ? null : intro };
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
    isEligible: isPlugEligible,
    loadCatalogue: () => liveCatalogue(),
    loadContext: async (userId) => {
      const [tiers, member] = await Promise.all([
        loadTiers().catch(() => ""),
        memberContext(userId).catch(() => null),
      ]);
      return { tiers, member: member ? memberContextLines(member) : "" };
    },
    warn: (m, e) => console.warn(`[ask-the-plug] ${m}`, e instanceof Error ? e.message : e),
    info: (m) => console.info(`[ask-the-plug] ${m}`),
  };
}
