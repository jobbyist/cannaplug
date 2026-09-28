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
  "slug" | "name" | "category" | "subcategory" | "description" | "price_rand" | "unit" | "strain_type" | "badge" | "sort_order" | "is_active"
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

async function assertRole(userId: string, minimum: "budtender" | "manager" | "admin") {
  const levels = { customer: 10, budtender: 20, manager: 30, admin: 40 } as const;
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) throw error;
  const role = (data ?? []).sort((a, b) => levels[b.role] - levels[a.role])[0]?.role;
  if (!role || levels[role] < levels[minimum]) throw new Error("Forbidden: insufficient staff permissions");
  return role;
}

async function loadOrders(limit = 50): Promise<AdminOrder[]> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rows = data ?? [];
  const orderIds = rows.map((row) => row.id);
  const itemRows = orderIds.length
    ? (await supabaseAdmin.from("order_items").select("*").in("order_id", orderIds)).data ?? []
    : [];
  const ids = [...new Set(rows.map((row) => row.user_id))];
  const profiles = ids.length
    ? (await supabaseAdmin.from("profiles").select("id,full_name").in("id", ids)).data ?? []
    : [];
  const authUsers = await Promise.all(ids.map(async (id) => {
    const result = await supabaseAdmin.auth.admin.getUserById(id);
    return result.data.user ? { id, email: result.data.user.email ?? null } : { id, email: null };
  }));
  const profileMap = new Map(profiles.map((p) => [p.id, p.full_name]));
  const emailMap = new Map(authUsers.map((u) => [u.id, u.email]));

  const itemsByOrder = new Map<string, Tables<"order_items">[]>();
  for (const item of itemRows) {
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

async function loadInventory(): Promise<InventorySummary[]> {
  const db = supabaseAdmin as any;
  const { data, error } = await db
    .from("inventory_ledger")
    .select("product_id, quantity_delta, inventory_batches!inner(id, product_id), products!inner(name)")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const map = new Map<string, InventorySummary>();
  for (const row of data ?? []) {
    const current = map.get(row.product_id) ?? {
      product_id: row.product_id,
      product_name: row.products?.name ?? "Unknown product",
      quantity_on_hand: 0,
      batches: 0,
    };
    current.quantity_on_hand += Number(row.quantity_delta ?? 0);
    if (row.inventory_batches?.id) current.batches += 1;
    map.set(row.product_id, current);
  }
  return [...map.values()].sort((a, b) => a.quantity_on_hand - b.quantity_on_hand);
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
    time: new Date(row.created_at).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }),
  }));
}

export async function getAdminDashboard(userId: string): Promise<AdminDashboard> {
  await assertRole(userId, "budtender");
  const [orders, inventory, activity] = await Promise.all([
    loadOrders(8),
    loadInventory(),
    loadActivity(),
  ]);

  const { count: totalOrders } = await supabaseAdmin.from("orders").select("id", { count: "exact", head: true });
  const { data: revenueRows } = await supabaseAdmin.from("orders").select("total_rand").eq("status", "completed");
  const { count: totalCustomers } = await supabaseAdmin.from("user_roles").select("user_id", { count: "exact", head: true }).eq("role", "customer");

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
      value: (recentSales ?? []).filter((row) => row.created_at.slice(0, 10) === key).reduce((sum, row) => sum + Number(row.total_rand), 0),
    };
  });

  const { data: topRows } = await supabaseAdmin
    .from("order_items")
    .select("product_name,quantity")
    .order("quantity", { ascending: false })
    .limit(100);
  const topMap = new Map<string, number>();
  for (const row of topRows ?? []) topMap.set(row.product_name, (topMap.get(row.product_name) ?? 0) + row.quantity);
  const topProducts = [...topMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, sold]) => ({ name, sold }));

  return {
    stats: {
      totalOrders: totalOrders ?? 0,
      revenueRand: (revenueRows ?? []).reduce((sum, row) => sum + Number(row.total_rand), 0),
      inventoryAlerts: inventory.filter((item) => item.quantity_on_hand <= 5).length,
      totalCustomers: totalCustomers ?? 0,
    },
    salesOverview,
    topProducts,
    recentOrders: orders,
    inventory,
    activity,
  };
}

export async function listAdminOrders(userId: string) {
  await assertRole(userId, "budtender");
  return loadOrders(100);
}

export async function getAdminOrder(userId: string, orderId: string) {
  await assertRole(userId, "budtender");
  const orders = await loadOrders(1000);
  return orders.find((order) => order.id === orderId) ?? null;
}

export async function transitionAdminOrder(
  userId: string,
  orderId: string,
  toStatus: AdminOrderStatus,
  note?: string,
) {
  await assertRole(userId, "budtender");
  const db = supabaseAdmin as any;
  const { data, error } = await db.rpc("transition_order_status", {
    p_order_id: orderId,
    p_to_status: toStatus,
    p_actor_user_id: userId,
    p_note: note ?? null,
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
  const { data, error } = await supabaseAdmin.from("products").select("*").order("sort_order").order("name");
  if (error) throw error;
  return data ?? [];
}

export async function saveAdminProduct(userId: string, input: AdminProductInput, productId?: string) {
  await assertRole(userId, "manager");
  if (productId) {
    const { data, error } = await supabaseAdmin.from("products").update(input as TablesUpdate<"products">).eq("id", productId).select().single();
    if (error) throw error;
    await supabaseAdmin.from("audit_log").insert({ actor_user_id: userId, action: "product_updated", entity_type: "product", entity_id: productId, metadata: { price_rand: input.price_rand } });
    return data;
  }
  const { data, error } = await supabaseAdmin.from("products").insert(input).select().single();
  if (error) throw error;
  await supabaseAdmin.from("audit_log").insert({ actor_user_id: userId, action: "product_created", entity_type: "product", entity_id: data.id });
  return data;
}

export async function deactivateAdminProduct(userId: string, productId: string) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin.from("products").update({ is_active: false }).eq("id", productId).select().single();
  if (error) throw error;
  await supabaseAdmin.from("audit_log").insert({ actor_user_id: userId, action: "product_deactivated", entity_type: "product", entity_id: productId });
  return data;
}

export async function listCustomers(userId: string) {
  await assertRole(userId, "budtender");
  const { data: roles, error } = await supabaseAdmin.from("user_roles").select("user_id,role,created_at").eq("role", "customer").order("created_at", { ascending: false }).limit(250);
  if (error) throw error;
  const ids = [...new Set((roles ?? []).map((r) => r.user_id))];
  const profiles = ids.length ? (await supabaseAdmin.from("profiles").select("id,full_name,phone,created_at").in("id", ids)).data ?? [] : [];
  const counts = ids.length ? (await supabaseAdmin.from("orders").select("user_id,total_rand").in("user_id", ids)).data ?? [] : [];
  return profiles.map((profile) => ({
    ...profile,
    orderCount: counts.filter((row) => row.user_id === profile.id).length,
    spendRand: counts.filter((row) => row.user_id === profile.id).reduce((sum, row) => sum + Number(row.total_rand), 0),
  }));
}

export async function listFulfilmentQueue(userId: string) {
  await assertRole(userId, "budtender");
  const orders = await loadOrders(100);
  return orders.filter((order) => ["confirmed", "packing", "ready", "out_for_delivery"].includes(order.status));
}

export async function listStoreProducts() {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id,slug,name,category,subcategory,strain_type,price_rand,unit,badge,description,is_active,sort_order")
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
    ? (await supabaseAdmin.from("order_items").select("*").in("order_id", orderIds)).data ?? []
    : [];
  return (data ?? []).map((order) => ({ ...order, items: items.filter((item) => item.order_id === order.id) }));
}
