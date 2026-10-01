import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type AdminOrderStatus =
  | "awaiting_payment"
  | "confirmed"
  | "packing"
  | "ready"
  | "out_for_delivery"
  | "completed"
  | "cancelled";

export const ORDER_TRANSITIONS: Record<AdminOrderStatus, AdminOrderStatus[]> = {
  awaiting_payment: ["confirmed", "cancelled"],
  confirmed: ["packing", "cancelled"],
  packing: ["ready"],
  ready: ["out_for_delivery"],
  out_for_delivery: ["completed"],
  completed: [],
  cancelled: [],
};

export type AdminProduct = Tables<"products">;
export type AdminProductInput = Pick<
  TablesInsert<"products">,
  | "slug"
  | "name"
  | "category"
  | "subcategory"
  | "description"
  | "price_rand"
  | "unit"
  | "strain_type"
  | "badge"
  | "sort_order"
  | "is_active"
>;

export type AdminOrder = Tables<"orders"> & {
  customer_name: string | null;
  customer_email: string | null;
  items: Tables<"order_items">[];
};

export type InventorySummary = {
  product_id: string;
  product_name: string;
  quantity_on_hand: number;
  held: number;
  available: number;
  batches: number;
};

export type AdminDashboard = {
  stats: {
    totalOrders: number;
    revenueRand: number;
    inventoryAlerts: number;
    totalCustomers: number;
  };
  salesOverview: { day: string; value: number }[];
  topProducts: { name: string; sold: number }[];
  recentOrders: AdminOrder[];
  inventory: InventorySummary[];
  activity: { label: string; time: string }[];
};

export async function assertRole(userId: string, minimum: "budtender" | "manager" | "admin") {
  const levels = { user: 10, customer: 10, budtender: 20, manager: 30, admin: 40 } as const;
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) throw error;
  const role = (data ?? []).sort((a, b) => levels[b.role] - levels[a.role])[0]?.role;
  if (!role || levels[role] < levels[minimum])
    throw new Error("Forbidden: insufficient staff permissions");
  return role;
}

const AUTH_LOOKUP_CONCURRENCY = 10;
const MAX_PAGE_SIZE = 100;

type OrderRow = Tables<"orders">;

/**
 * Resolve auth emails in bounded batches so a page of orders can never fan out
 * into an unbounded burst of Auth Admin API calls. A failed lookup degrades to
 * a null email rather than failing the whole order list.
 */
async function loadEmails(ids: string[]): Promise<Map<string, string | null>> {
  const emails = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += AUTH_LOOKUP_CONCURRENCY) {
    const batch = ids.slice(i, i + AUTH_LOOKUP_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          const { data } = await supabaseAdmin.auth.admin.getUserById(id);
          return [id, data.user?.email ?? null] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    for (const [id, email] of results) emails.set(id, email);
  }
  return emails;
}

async function hydrateOrders(rows: OrderRow[]): Promise<AdminOrder[]> {
  if (!rows.length) return [];
  const orderIds = rows.map((row) => row.id);
  const ids = [...new Set(rows.map((row) => row.user_id))];

  const [itemsResult, profilesResult, emailMap] = await Promise.all([
    supabaseAdmin.from("order_items").select("*").in("order_id", orderIds),
    supabaseAdmin.from("profiles").select("id,full_name").in("id", ids),
    loadEmails(ids),
  ]);
  if (itemsResult.error) throw itemsResult.error;
  if (profilesResult.error) throw profilesResult.error;

  const profileMap = new Map((profilesResult.data ?? []).map((p) => [p.id, p.full_name]));
  const itemsByOrder = new Map<string, Tables<"order_items">[]>();
  for (const item of itemsResult.data ?? []) {
    const list = itemsByOrder.get(item.order_id) ?? [];
    list.push(item);
    itemsByOrder.set(item.order_id, list);
  }

  return rows.map((order) => ({
    ...order,
    items: itemsByOrder.get(order.id) ?? [],
    customer_name: profileMap.get(order.user_id) ?? order.contact_name,
    customer_email: emailMap.get(order.user_id) ?? null,
  }));
}

export type OrderPage = {
  limit?: number;
  /** ISO created_at of the last row already loaded; returns the next (older) page. */
  before?: string;
  statuses?: AdminOrderStatus[];
};

async function loadOrders({ limit = 50, before, statuses }: OrderPage = {}): Promise<AdminOrder[]> {
  let query = supabaseAdmin
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), MAX_PAGE_SIZE));
  if (before) query = query.lt("created_at", before);
  if (statuses?.length) query = query.in("status", statuses);
  const { data, error } = await query;
  if (error) throw error;
  return hydrateOrders(data ?? []);
}

async function loadInventory(): Promise<InventorySummary[]> {
  // Read model over the single inventory engine: on hand, held (online reservations) and available.
  const { data, error } = await supabaseAdmin
    .from("inventory_availability")
    .select("product_id,on_hand,held,available,batches")
    .gt("batches", 0);
  if (error) throw error;

  // View columns are nullable in generated types; normalise once here.
  const rows = (data ?? []).flatMap((row) =>
    row.product_id
      ? [
          {
            product_id: row.product_id,
            on_hand: row.on_hand ?? 0,
            held: row.held ?? 0,
            available: row.available ?? 0,
            batches: row.batches ?? 0,
          },
        ]
      : [],
  );
  const ids = rows.map((row) => row.product_id);
  const products = ids.length
    ? ((await supabaseAdmin.from("products").select("id,name").in("id", ids)).data ?? [])
    : [];
  const names = new Map(products.map((p) => [p.id, p.name]));
  return rows
    .map((row) => ({
      product_id: row.product_id,
      product_name: names.get(row.product_id) ?? "Unknown product",
      quantity_on_hand: row.on_hand,
      held: row.held,
      available: row.available,
      batches: row.batches,
    }))
    .sort((a, b) => a.available - b.available);
}

async function loadActivity(limit = 8) {
  const { data, error } = await supabaseAdmin
    .from("audit_log")
    .select("action,entity_type,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    label: `${row.action.replaceAll("_", " ")} · ${row.entity_type}`,
    time: new Date(row.created_at).toLocaleString("en-ZA", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
  }));
}

export async function getAdminDashboard(userId: string): Promise<AdminDashboard> {
  await assertRole(userId, "budtender");
  const [orders, inventory, activity] = await Promise.all([
    loadOrders({ limit: 8 }),
    loadInventory(),
    loadActivity(),
  ]);

  const { count: totalOrders } = await supabaseAdmin
    .from("orders")
    .select("id", { count: "exact", head: true });
  const { data: revenueRows } = await supabaseAdmin
    .from("orders")
    .select("total_rand")
    .eq("status", "completed");
  const { count: totalCustomers } = await supabaseAdmin
    .from("user_roles")
    .select("user_id", { count: "exact", head: true })
    .eq("role", "customer");

  const lastSeven = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    return date;
  });
  const { data: recentSales } = await supabaseAdmin
    .from("orders")
    .select("total_rand,created_at")
    .eq("status", "completed")
    .gte("created_at", lastSeven[0]!.toISOString());

  const salesOverview = lastSeven.map((date) => {
    const key = date.toISOString().slice(0, 10);
    return {
      day: date.toLocaleDateString("en-ZA", { weekday: "short" }),
      value: (recentSales ?? [])
        .filter((row) => row.created_at.slice(0, 10) === key)
        .reduce((sum, row) => sum + Number(row.total_rand), 0),
    };
  });

  const { data: topRows } = await supabaseAdmin
    .from("order_items")
    .select("product_name,quantity")
    .order("quantity", { ascending: false })
    .limit(100);
  const topMap = new Map<string, number>();
  for (const row of topRows ?? [])
    topMap.set(row.product_name, (topMap.get(row.product_name) ?? 0) + row.quantity);
  const topProducts = [...topMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, sold]) => ({ name, sold }));

  return {
    stats: {
      totalOrders: totalOrders ?? 0,
      revenueRand: (revenueRows ?? []).reduce((sum, row) => sum + Number(row.total_rand), 0),
      inventoryAlerts: inventory.filter((item) => item.available <= 5).length,
      totalCustomers: totalCustomers ?? 0,
    },
    salesOverview,
    topProducts,
    recentOrders: orders,
    inventory,
    activity,
  };
}

export async function listAdminOrders(
  userId: string,
  page: Pick<OrderPage, "limit" | "before"> = {},
) {
  await assertRole(userId, "budtender");
  return loadOrders({ limit: MAX_PAGE_SIZE, ...page });
}

export async function getAdminOrder(userId: string, orderId: string) {
  await assertRole(userId, "budtender");
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [order] = await hydrateOrders([data]);
  return order ?? null;
}

export async function transitionAdminOrder(
  userId: string,
  orderId: string,
  toStatus: AdminOrderStatus,
  note?: string,
) {
  await assertRole(userId, "budtender");
  const { data, error } = await supabaseAdmin.rpc("transition_order_status", {
    p_order_id: orderId,
    p_to_status: toStatus,
    p_actor_user_id: userId,
    ...(note ? { p_note: note } : {}),
  });
  if (error) throw error;
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: "order_status_changed",
    entity_type: "order",
    entity_id: orderId,
    metadata: { to_status: toStatus },
  });
  return data;
}

export async function listAdminProducts(userId: string) {
  await assertRole(userId, "budtender");
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("*")
    .order("sort_order")
    .order("name");
  if (error) throw error;
  return data ?? [];
}

export async function saveAdminProduct(
  userId: string,
  input: AdminProductInput,
  productId?: string,
) {
  await assertRole(userId, "manager");
  if (productId) {
    const { data, error } = await supabaseAdmin
      .from("products")
      .update(input as TablesUpdate<"products">)
      .eq("id", productId)
      .select()
      .single();
    if (error) throw error;
    await supabaseAdmin.from("audit_log").insert({
      actor_user_id: userId,
      action: "product_updated",
      entity_type: "product",
      entity_id: productId,
      metadata: { price_rand: input.price_rand },
    });
    return data;
  }
  const { data, error } = await supabaseAdmin.from("products").insert(input).select().single();
  if (error) throw error;
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: "product_created",
    entity_type: "product",
    entity_id: data.id,
  });
  return data;
}

export async function deactivateAdminProduct(userId: string, productId: string) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin
    .from("products")
    .update({ is_active: false })
    .eq("id", productId)
    .select()
    .single();
  if (error) throw error;
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: "product_deactivated",
    entity_type: "product",
    entity_id: productId,
  });
  return data;
}

export async function listCustomers(userId: string) {
  await assertRole(userId, "budtender");
  const { data: roles, error } = await supabaseAdmin
    .from("user_roles")
    .select("user_id,role,created_at")
    .eq("role", "customer")
    .order("created_at", { ascending: false })
    .limit(250);
  if (error) throw error;
  const ids = [...new Set((roles ?? []).map((r) => r.user_id))];
  const profiles = ids.length
    ? ((await supabaseAdmin.from("profiles").select("id,full_name,phone,created_at").in("id", ids))
        .data ?? [])
    : [];
  const counts = ids.length
    ? ((await supabaseAdmin.from("orders").select("user_id,total_rand").in("user_id", ids)).data ??
      [])
    : [];
  return profiles.map((profile) => ({
    ...profile,
    orderCount: counts.filter((row) => row.user_id === profile.id).length,
    spendRand: counts
      .filter((row) => row.user_id === profile.id)
      .reduce((sum, row) => sum + Number(row.total_rand), 0),
  }));
}

export type EftConfirmOutcome =
  | "confirmed"
  | "amount_mismatch"
  | "already_processed"
  | "paid_after_cancel_needs_refund"
  | "stock_unavailable_needs_refund"
  | "order_not_found";

/**
 * Staff confirm an EFT that has cleared. Goes through confirm_order_payment (the same path a payment
 * webhook uses), so the bank reference is idempotent and cannot be reused on another order, the amount
 * received must equal the order's payable total, stock is consumed atomically, and a payment_events
 * row is the receipt. The plain status button is no longer offered for unpaid orders.
 */
export async function confirmOrderPayment(
  userId: string,
  orderId: string,
  bankReference: string,
  amountReceived: number,
) {
  await assertRole(userId, "budtender");
  const { data, error } = await supabaseAdmin.rpc("confirm_order_payment", {
    p_provider: "eft",
    p_provider_event_id: bankReference,
    p_order_id: orderId,
    p_amount: amountReceived,
  });
  if (error) throw error;
  const result = data as { duplicate: boolean; outcome: EftConfirmOutcome; order_id: string };
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: "order_payment_confirmed",
    entity_type: "order",
    entity_id: orderId,
    metadata: { outcome: result.outcome, duplicate: result.duplicate, amount: amountReceived },
  });
  return result;
}

export async function listFulfilmentQueue(userId: string) {
  await assertRole(userId, "budtender");
  return loadOrders({
    limit: MAX_PAGE_SIZE,
    statuses: ["confirmed", "packing", "ready", "out_for_delivery"],
  });
}

export async function listStoreProducts() {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select(
      "id,slug,name,category,subcategory,strain_type,price_rand,unit,badge,description,is_active,sort_order",
    )
    .eq("is_active", true)
    .order("sort_order")
    .order("name");
  if (error) throw error;
  return data ?? [];
}

export async function listMemberOrders(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const orderIds = (data ?? []).map((order) => order.id);
  const items = orderIds.length
    ? ((await supabaseAdmin.from("order_items").select("*").in("order_id", orderIds)).data ?? [])
    : [];
  return (data ?? []).map((order) => ({
    ...order,
    items: items.filter((item) => item.order_id === order.id),
  }));
}
