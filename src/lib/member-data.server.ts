import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { friendlyMemberError, rulesFromRows, type ReorderCheck } from "@/lib/member-logic";

/**
 * Member account data layer.
 *
 *  - READS use the caller's own user-scoped client, so Row Level Security (not a WHERE clause we
 *    might forget) is what limits every row to the signed-in member.
 *  - Anything that must be atomic or that clients may never write directly (addresses, loyalty,
 *    reorder) goes through service-only RPCs, with the acting member id taken from the verified
 *    JWT by the auth middleware. The browser never supplies a user id, price, total or balance.
 */
export type UserClient = SupabaseClient<Database>;

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw friendlyMemberError(res.error);
  return res.data as T;
}

const ORDER_LIMIT = 50;
const TXN_LIMIT = 50;

export async function getMemberAccount(db: UserClient) {
  const [orders, addresses, account, tiers, rules, txns, wishlist, alerts, products, availability] =
    await Promise.all([
      db.from("orders").select("*").order("created_at", { ascending: false }).limit(ORDER_LIMIT),
      db
        .from("addresses")
        .select("*")
        .order("is_default", { ascending: false })
        .order("updated_at", { ascending: false }),
      db.from("loyalty_accounts").select("points_balance,lifetime_points,tier_id").maybeSingle(),
      db
        .from("loyalty_tiers")
        .select("id,code,name,min_lifetime_points,perks")
        .order("min_lifetime_points"),
      db.from("loyalty_rules").select("code,value"),
      db
        .from("loyalty_transactions")
        .select("id,txn_type,source_type,order_id,pos_sale_id,points,balance_after,created_at")
        .order("created_at", { ascending: false })
        .limit(TXN_LIMIT),
      db
        .from("wishlist_items")
        .select("product_id,created_at")
        .order("created_at", { ascending: false }),
      db
        .from("back_in_stock_subscriptions")
        .select("id,product_id,status,created_at,notified_at")
        .order("created_at", { ascending: false }),
      db
        .from("products")
        .select(
          "id,slug,name,category,subcategory,strain_type,price_rand,unit,badge,description,sort_order",
        )
        .eq("is_active", true)
        .order("sort_order")
        .order("name"),
      // Stock counts are staff-only; members only ever learn a boolean per product.
      supabaseAdmin.from("inventory_availability").select("product_id,available"),
    ]);

  const orderRows = unwrap(orders);
  const orderIds = orderRows.map((o) => o.id);
  const [items, history] = orderIds.length
    ? await Promise.all([
        db.from("order_items").select("*").in("order_id", orderIds),
        db
          .from("order_status_history")
          .select("id,order_id,from_status,to_status,created_at")
          .in("order_id", orderIds)
          .order("created_at", { ascending: true }),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ];
  const itemRows = unwrap(items) ?? [];
  const historyRows = unwrap(history) ?? [];

  const inStock = new Set(
    (unwrap(availability) ?? []).filter((a) => (a.available ?? 0) > 0).map((a) => a.product_id),
  );
  const tierRows = unwrap(tiers) ?? [];
  const accountRow = unwrap(account);
  const currentTier = tierRows.find((t) => t.id === accountRow?.tier_id) ?? null;

  return {
    orders: orderRows.map((order) => ({
      ...order,
      items: itemRows.filter((i) => i.order_id === order.id),
      timeline: historyRows.filter((h) => h.order_id === order.id),
    })),
    addresses: unwrap(addresses) ?? [],
    loyalty: {
      balance: accountRow?.points_balance ?? 0,
      lifetime: accountRow?.lifetime_points ?? 0,
      tierCode: currentTier?.code ?? null,
      tiers: tierRows.map((t) => ({
        code: t.code,
        name: t.name,
        min_lifetime_points: t.min_lifetime_points,
        perks: t.perks,
      })),
      rules: rulesFromRows(unwrap(rules) ?? []),
      transactions: unwrap(txns) ?? [],
    },
    wishlist: (unwrap(wishlist) ?? []).map((w) => w.product_id),
    alerts: unwrap(alerts) ?? [],
    products: (unwrap(products) ?? []).map((p) => ({ ...p, in_stock: inStock.has(p.id) })),
  };
}

export type MemberAccount = Awaited<ReturnType<typeof getMemberAccount>>;

// -------------------------------------------------------------------------------------------
// Addresses (service-only RPCs: ownership + single-default + cap enforced in the database)
// -------------------------------------------------------------------------------------------

export type AddressInput = {
  label: string;
  recipient_name?: string | null | undefined;
  phone?: string | null | undefined;
  line1: string;
  line2?: string | null | undefined;
  suburb?: string | null | undefined;
  city?: string | null | undefined;
  province?: string | null | undefined;
  postal_code?: string | null | undefined;
  delivery_notes?: string | null | undefined;
};

export async function saveMemberAddress(
  userId: string,
  addressId: string | null,
  input: AddressInput,
  makeDefault: boolean,
) {
  return unwrap(
    await supabaseAdmin.rpc("member_save_address", {
      p_user_id: userId,
      p_address_id: addressId,
      p_data: input as unknown as Json,
      p_make_default: makeDefault,
    }),
  );
}

export async function setDefaultMemberAddress(userId: string, addressId: string) {
  return unwrap(
    await supabaseAdmin.rpc("member_set_default_address", {
      p_user_id: userId,
      p_address_id: addressId,
    }),
  );
}

export async function deleteMemberAddress(userId: string, addressId: string) {
  return unwrap(
    await supabaseAdmin.rpc("member_delete_address", {
      p_user_id: userId,
      p_address_id: addressId,
    }),
  );
}

// -------------------------------------------------------------------------------------------
// Loyalty redemption, reorder
// -------------------------------------------------------------------------------------------

export async function redeemLoyaltyPoints(
  userId: string,
  orderId: string,
  points: number,
  key: string,
) {
  return unwrap(
    await supabaseAdmin.rpc("redeem_loyalty_points", {
      p_user_id: userId,
      p_order_id: orderId,
      p_points: points,
      p_idempotency_key: key,
    }),
  );
}

export async function checkReorder(userId: string, orderId: string): Promise<ReorderCheck> {
  return unwrap(
    await supabaseAdmin.rpc("reorder_check", { p_user_id: userId, p_order_id: orderId }),
  ) as unknown as ReorderCheck;
}

export async function createReorder(
  userId: string,
  orderId: string,
  expectedTotal: number,
  key: string,
) {
  return unwrap(
    await supabaseAdmin.rpc("create_reorder", {
      p_user_id: userId,
      p_source_order_id: orderId,
      p_expected_total: expectedTotal,
      p_idempotency_key: key,
    }),
  );
}

// -------------------------------------------------------------------------------------------
// Wishlist + back-in-stock (direct, under RLS: the database rejects any row that is not the caller's)
// -------------------------------------------------------------------------------------------

export async function setWishlist(
  db: UserClient,
  userId: string,
  productId: string,
  saved: boolean,
) {
  if (saved) {
    const { error } = await db
      .from("wishlist_items")
      .insert({ user_id: userId, product_id: productId });
    // Saving twice is a no-op, not an error.
    if (error && !/duplicate key/i.test(error.message)) throw friendlyMemberError(error);
  } else {
    unwrap(
      await db.from("wishlist_items").delete().eq("user_id", userId).eq("product_id", productId),
    );
  }
}

export async function setStockAlert(
  db: UserClient,
  userId: string,
  productId: string,
  enabled: boolean,
) {
  if (enabled) {
    const { error } = await db
      .from("back_in_stock_subscriptions")
      .insert({ user_id: userId, product_id: productId });
    if (error && !/duplicate key/i.test(error.message)) throw friendlyMemberError(error);
  } else {
    unwrap(
      await db
        .from("back_in_stock_subscriptions")
        .delete()
        .eq("user_id", userId)
        .eq("product_id", productId),
    );
  }
}
