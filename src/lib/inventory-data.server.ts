import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import type { InventoryRow } from "@/lib/inventory-logic";
import { productImageUrl } from "@/lib/product-image-url.server";

/**
 * /admin → Inventory read model and the one product setting it changes (the low-stock alert level).
 * Stock itself only ever changes through the receive_stock / adjust_stock RPCs (pos-data.server.ts).
 */

const MAX_ROWS = 5000;

export async function listInventory(userId: string): Promise<InventoryRow[]> {
  const role = await assertRole(userId, "budtender");
  const seesCost = role === "manager" || role === "admin";
  const [productsRes, availabilityRes, batchesRes] = await Promise.all([
    supabaseAdmin
      .from("products")
      .select(
        "id,name,sku,category,brand,unit,sold_by_weight,is_active,sell_online,track_stock,low_stock_threshold,price_rand,regular_price_rand,cost_rand,image_path",
      )
      .order("name")
      .range(0, MAX_ROWS - 1),
    supabaseAdmin
      .from("inventory_availability")
      .select("product_id,on_hand,held,available,expired,batches")
      .range(0, MAX_ROWS - 1),
    supabaseAdmin
      .from("inventory_batches")
      .select("product_id,expires_at")
      .gt("qty_on_hand", 0)
      .gt("expires_at", new Date().toISOString())
      .order("expires_at")
      .range(0, MAX_ROWS * 4 - 1),
  ]);
  for (const r of [productsRes, availabilityRes, batchesRes]) if (r.error) throw r.error;

  const stock = new Map((availabilityRes.data ?? []).map((a) => [a.product_id, a]));
  const nextExpiry = new Map<string, string>();
  for (const b of batchesRes.data ?? [])
    if (b.expires_at && !nextExpiry.has(b.product_id)) nextExpiry.set(b.product_id, b.expires_at);

  return (productsRes.data ?? []).map((p) => {
    const s = stock.get(p.id);
    const onHand = s?.on_hand ?? 0;
    return {
      product_id: p.id,
      name: p.name,
      sku: p.sku,
      category: p.category,
      brand: p.brand,
      unit: p.unit,
      sold_by_weight: p.sold_by_weight,
      is_active: p.is_active,
      sell_online: p.sell_online,
      track_stock: p.track_stock,
      low_stock_threshold: p.low_stock_threshold ?? 5,
      price_rand: Number(p.price_rand),
      regular_price_rand: p.regular_price_rand == null ? null : Number(p.regular_price_rand),
      image_url: productImageUrl(p.image_path),
      on_hand: onHand,
      held: s?.held ?? 0,
      available: s?.available ?? 0,
      expired: s?.expired ?? 0,
      batches: s?.batches ?? 0,
      next_expiry: nextExpiry.get(p.id) ?? null,
      stock_value:
        seesCost && p.cost_rand != null
          ? Math.round(onHand * Number(p.cost_rand) * 100) / 100
          : null,
    };
  });
}

export type StockMovement = {
  id: string;
  created_at: string;
  movement_type: string;
  quantity_delta: number;
  reason: string;
  batch_code: string | null;
  actor_name: string | null;
};

/** The latest stock movements for one product, newest first. Staff names only; no customer data. */
export async function listStockHistory(
  userId: string,
  productId: string,
  limit = 50,
): Promise<StockMovement[]> {
  await assertRole(userId, "budtender");
  const { data, error } = await supabaseAdmin
    .from("inventory_ledger")
    .select("id,created_at,movement_type,quantity_delta,reason,batch_id,actor_user_id")
    .eq("product_id", productId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) throw error;
  const rows = data ?? [];
  const batchIds = [...new Set(rows.map((r) => r.batch_id))];
  const actorIds = [...new Set(rows.map((r) => r.actor_user_id).filter((x): x is string => !!x))];
  const [batches, actors] = await Promise.all([
    batchIds.length
      ? supabaseAdmin.from("inventory_batches").select("id,batch_code").in("id", batchIds)
      : Promise.resolve({ data: [] as { id: string; batch_code: string }[] }),
    actorIds.length
      ? supabaseAdmin.from("profiles").select("id,full_name").in("id", actorIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
  ]);
  const codes = new Map((batches.data ?? []).map((b) => [b.id, b.batch_code]));
  const names = new Map((actors.data ?? []).map((a) => [a.id, a.full_name]));
  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    movement_type: r.movement_type,
    quantity_delta: r.quantity_delta,
    // Sale and refund rows carry an order or receipt reference in the reason; keep it as written.
    reason: r.reason,
    batch_code: codes.get(r.batch_id) ?? null,
    actor_name: r.actor_user_id ? (names.get(r.actor_user_id) ?? "Staff member") : null,
  }));
}

/** Managers set the level at which a product counts as low stock (daily low-stock email and this tab). */
export async function setLowStockThreshold(userId: string, productId: string, threshold: number) {
  await assertRole(userId, "manager");
  const { data: before, error: readError } = await supabaseAdmin
    .from("products")
    .select("low_stock_threshold")
    .eq("id", productId)
    .single();
  if (readError) throw new Error("Product not found.");
  const { error } = await supabaseAdmin
    .from("products")
    .update({ low_stock_threshold: threshold })
    .eq("id", productId);
  if (error) throw error;
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: "product_low_stock_threshold_set",
    entity_type: "product",
    entity_id: productId,
    metadata: { from: before.low_stock_threshold, to: threshold },
  });
  return { product_id: productId, low_stock_threshold: threshold };
}
