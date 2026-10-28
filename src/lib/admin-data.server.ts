import { canonicalSubcategory } from "@/lib/catalogue-taxonomy";
import { saleProblem } from "@/lib/sale-price";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { productImageUrl } from "@/lib/product-image-url.server";
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
  | "sku"
  | "barcode"
  | "cost_rand"
  | "brand"
  | "sell_online"
  | "sold_by_weight"
  | "weight_step_g"
  | "sale_ends_at"
  | "sale_online_only"
  | "is_featured"
  | "low_stock_threshold"
> & {
  /** Discounted selling price; empty = not on sale. price_rand is the regular price as typed by staff. */
  sale_price_rand?: number | null;
};

/** Staff type a regular price and an optional sale price; the database stores the selling price in price_rand
 *  and the regular price in regular_price_rand while a sale runs, so checkout and the till need no changes. */
function toProductColumns(input: AdminProductInput) {
  const { sale_price_rand, ...rest } = input;
  // A sale price that is not lower used to be dropped silently; refuse it so staff know the sale is not on.
  const problem = saleProblem({
    price: input.price_rand,
    sale: sale_price_rand,
    endsAt: input.sale_ends_at,
  });
  if (problem) throw new Error(problem);
  const onSale =
    sale_price_rand != null && sale_price_rand >= 0 && sale_price_rand < input.price_rand;
  return {
    ...rest,
    // "top shelf", "Top Shelf" and " TOP  SHELF " are the same grade: save the shop's spelling.
    subcategory: canonicalSubcategory(input.category, input.subcategory),
    price_rand: onSale ? sale_price_rand : input.price_rand,
    regular_price_rand: onSale ? input.price_rand : null,
    sale_ends_at: onSale ? (input.sale_ends_at ?? null) : null,
    // Online only: the shop charges the sale price, the till keeps the regular one.
    sale_online_only: onSale ? Boolean(input.sale_online_only) : false,
  };
}

/** What staff may see about a linked prescription: number, validity and a public verify token. Never clinical text. */
export type OrderPrescription = {
  document_number: string;
  valid_until: string | null;
  verify_token: string;
  link_status: "active" | "flagged";
  valid: boolean;
};

export type AdminOrder = Tables<"orders"> & {
  customer_name: string | null;
  customer_email: string | null;
  items: Tables<"order_items">[];
  prescription?: OrderPrescription | null;
};

async function withPrescriptions(userId: string, orders: AdminOrder[]): Promise<AdminOrder[]> {
  if (!orders.length) return orders;
  const { data, error } = await supabaseAdmin.rpc("order_prescription_summaries", {
    p_actor: userId,
    p_order_ids: orders.map((o) => o.id),
  });
  if (error) return orders; // the order list must still load
  const map = (data ?? {}) as Record<string, OrderPrescription>;
  return orders.map((o) => ({ ...o, prescription: map[o.id] ?? null }));
}

export type InventorySummary = {
  product_id: string;
  product_name: string;
  quantity_on_hand: number;
  held: number;
  available: number;
  batches: number;
};

export type Money = { pos: number; online: number; total: number };

export type AdminDashboard = {
  stats: {
    /** Paid online orders plus till sales net of refunds, by South African day (same rule as Reports). */
    revenue: { today: Money; week: Money; month: Money; allTime: Money };
    /** Paid online orders and till sales that were not voided. */
    totalSales: number;
    paidOnline: number;
    tillSales: number;
    inventoryAlerts: number;
    /** Members only: staff are not counted. */
    totalCustomers: number;
  };
  salesOverview: { day: string; label: string; pos: number; online: number; total: number }[];
  /** Best sellers of the last 30 days across both channels. */
  topProducts: { name: string; sold: number; revenue: number }[];
  recentOrders: AdminOrder[];
  inventory: InventorySummary[];
  activity: { label: string; time: string }[];
};

/** The person's highest staff role, or null when they are not staff. */
export async function staffRoleOf(
  userId: string,
): Promise<"budtender" | "manager" | "admin" | null> {
  try {
    return (await assertRole(userId, "budtender")) as "budtender" | "manager" | "admin";
  } catch (err) {
    if (err instanceof Error && /^Forbidden/.test(err.message)) return null;
    throw err;
  }
}

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
  /** Archived orders (test or abandoned) are hidden unless asked for. */
  includeArchived?: boolean;
};

async function loadOrders({
  limit = 50,
  before,
  statuses,
  includeArchived = false,
}: OrderPage = {}): Promise<AdminOrder[]> {
  let query = supabaseAdmin
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), MAX_PAGE_SIZE));
  if (before) query = query.lt("created_at", before);
  if (statuses?.length) query = query.in("status", statuses);
  if (!includeArchived) query = query.is("archived_at", null);
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

const money = (v: { pos?: unknown; online?: unknown } | undefined): Money => {
  const pos = Number(v?.pos ?? 0);
  const online = Number(v?.online ?? 0);
  return { pos, online, total: Math.round((pos + online) * 100) / 100 };
};

type OverviewJson = {
  today?: { pos?: unknown; online?: unknown };
  week?: { pos?: unknown; online?: unknown };
  month?: { pos?: unknown; online?: unknown };
  all_time?: { pos?: unknown; online?: unknown };
  daily?: { day: string; pos: unknown; online: unknown }[];
  top_products?: { name: string; qty: unknown; revenue: unknown }[];
  counts?: Record<string, unknown>;
};

export async function getAdminDashboard(userId: string): Promise<AdminDashboard> {
  await assertRole(userId, "budtender");
  // All sums, days and rankings are worked out inside the database (no row caps, South African days).
  const [orders, inventory, activity, overview, attention] = await Promise.all([
    loadOrders({ limit: 8 }),
    loadInventory(),
    loadActivity(),
    supabaseAdmin.rpc("admin_overview", { p_actor: userId }),
    supabaseAdmin.rpc("admin_attention_counts", { p_actor: userId }),
  ]);
  if (overview.error) throw overview.error;
  if (attention.error) throw attention.error;
  const o = (overview.data ?? {}) as OverviewJson;
  const counts = o.counts ?? {};
  const alerts = (attention.data ?? {}) as Record<string, unknown>;

  return {
    stats: {
      revenue: {
        today: money(o.today),
        week: money(o.week),
        month: money(o.month),
        allTime: money(o.all_time),
      },
      paidOnline: Number(counts["paid_online"] ?? 0),
      tillSales: Number(counts["till_sales"] ?? 0),
      totalSales: Number(counts["paid_online"] ?? 0) + Number(counts["till_sales"] ?? 0),
      inventoryAlerts: Number(alerts["low_stock"] ?? 0),
      totalCustomers: Number(counts["customers"] ?? 0),
    },
    salesOverview: (o.daily ?? []).map((d) => {
      const m = money(d);
      return {
        day: d.day,
        label: new Date(`${d.day}T12:00:00Z`).toLocaleDateString("en-ZA", {
          weekday: "short",
          timeZone: "UTC",
        }),
        ...m,
      };
    }),
    topProducts: (o.top_products ?? []).map((p) => ({
      name: p.name,
      sold: Number(p.qty),
      revenue: Number(p.revenue),
    })),
    recentOrders: orders,
    inventory,
    activity,
  };
}

export type AttentionCounts = {
  orders_to_pack: number;
  id_checks: number;
  variances: number;
  low_stock: number;
  eft_waiting: number;
};

export async function getAttentionCounts(userId: string): Promise<AttentionCounts> {
  await assertRole(userId, "budtender");
  const { data, error } = await supabaseAdmin.rpc("admin_attention_counts", { p_actor: userId });
  if (error) throw error;
  const c = (data ?? {}) as Record<string, unknown>;
  return {
    orders_to_pack: Number(c["orders_to_pack"] ?? 0),
    id_checks: Number(c["id_checks"] ?? 0),
    variances: Number(c["variances"] ?? 0),
    low_stock: Number(c["low_stock"] ?? 0),
    eft_waiting: Number(c["eft_waiting"] ?? 0),
  };
}

export async function listAdminOrders(
  userId: string,
  page: Pick<OrderPage, "limit" | "before" | "includeArchived"> = {},
) {
  await assertRole(userId, "budtender");
  return withPrescriptions(userId, await loadOrders({ limit: MAX_PAGE_SIZE, ...page }));
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
  const [order] = await withPrescriptions(userId, await hydrateOrders([data]));
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
  const role = await assertRole(userId, "budtender");
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("*")
    .order("sort_order")
    .order("name");
  if (error) throw error;
  // Cost price is manager+ information: budtenders get the list without it.
  const seesCost = role === "manager" || role === "admin";
  return (data ?? []).map((p) => ({
    ...p,
    cost_rand: seesCost ? p.cost_rand : null,
    image_url: productImageUrl(p.image_path),
  }));
}

/** Maps unique-index violations to a message a manager can act on. */
function productSaveError(error: { code?: string; message?: string }): Error {
  if (error.code === "23505" && /sku/i.test(error.message ?? ""))
    return new Error("That SKU is already used by another product.");
  if (error.code === "23505" && /barcode/i.test(error.message ?? ""))
    return new Error("That barcode is already used by another product.");
  if (error.code === "23505" && /slug/i.test(error.message ?? ""))
    return new Error("That slug is already used by another product.");
  if (error.code === "23514") return new Error("Check the SKU, barcode and cost price format.");
  return error instanceof Error ? error : new Error(error.message ?? "Could not save the product.");
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
      .update(toProductColumns(input) as TablesUpdate<"products">)
      .eq("id", productId)
      .select()
      .single();
    if (error) throw productSaveError(error);
    await supabaseAdmin.from("audit_log").insert({
      actor_user_id: userId,
      action: "product_updated",
      entity_type: "product",
      entity_id: productId,
      metadata: {
        price_rand: input.price_rand,
        sku: input.sku ?? null,
        cost_changed: input.cost_rand !== undefined,
      },
    });
    return data;
  }
  const { data, error } = await supabaseAdmin
    .from("products")
    .insert(toProductColumns(input) as TablesInsert<"products">)
    .select()
    .single();
  if (error) throw productSaveError(error);
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: "product_created",
    entity_type: "product",
    entity_id: data.id,
  });
  return data;
}

/**
 * Put a product on sale (or end its sale) without the full product editor: used from the till.
 * The regular price is kept; the sale price is what both the till and online checkout charge.
 */
export async function setProductSale(
  userId: string,
  productId: string,
  input: { sale_price_rand: number | null; sale_ends_at: string | null; online_only?: boolean },
) {
  // Any staff member on the till may run a sale (owner's decision, 27 Oct 2026); every change is audited.
  await assertRole(userId, "budtender");
  const { data: p, error: readError } = await supabaseAdmin
    .from("products")
    .select("id,name,price_rand,regular_price_rand")
    .eq("id", productId)
    .single();
  if (readError || !p) throw new Error("Product not found.");
  const regular = Number(p.regular_price_rand ?? p.price_rand);
  const ending = input.sale_price_rand == null;
  if (!ending) {
    const problem = saleProblem({
      price: regular,
      sale: input.sale_price_rand,
      endsAt: input.sale_ends_at,
    });
    if (problem) throw new Error(problem);
  }
  const { data, error } = await supabaseAdmin
    .from("products")
    .update(
      ending
        ? {
            price_rand: regular,
            regular_price_rand: null,
            sale_ends_at: null,
            sale_online_only: false,
          }
        : {
            price_rand: input.sale_price_rand!,
            regular_price_rand: regular,
            sale_ends_at: input.sale_ends_at,
            sale_online_only: Boolean(input.online_only),
          },
    )
    .eq("id", productId)
    .select("id,price_rand,regular_price_rand,sale_ends_at")
    .single();
  if (error) throw productSaveError(error);
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: ending ? "product_sale_ended_by_staff" : "product_sale_set",
    entity_type: "product",
    entity_id: productId,
    metadata: {
      regular_price: regular,
      sale_price: ending ? null : input.sale_price_rand,
      sale_ends_at: ending ? null : input.sale_ends_at,
      online_only: ending ? false : Boolean(input.online_only),
      from: "pos",
    },
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

export type CustomerRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  member_since: string;
  order_count: number;
  spend_rand: number;
};

/** Members (not staff), newest first, with search and paging done in the database. */
export async function listCustomersPage(
  userId: string,
  opts: { search?: string | null; limit?: number; offset?: number } = {},
): Promise<{ total: number; rows: CustomerRow[] }> {
  await assertRole(userId, "budtender");
  const { data, error } = await supabaseAdmin.rpc("admin_customers_page", {
    p_actor: userId,
    p_search: opts.search?.trim() ? opts.search.trim() : null,
    p_limit: opts.limit ?? 25,
    p_offset: opts.offset ?? 0,
  });
  if (error) throw error;
  const d = (data ?? { total: 0, rows: [] }) as { total: number; rows: CustomerRow[] };
  return {
    total: Number(d.total),
    rows: (d.rows ?? []).map((r) => ({
      ...r,
      order_count: Number(r.order_count),
      spend_rand: Number(r.spend_rand),
    })),
  };
}

/** Hide (or restore) a cancelled or unpaid order. A paid order can never be archived. */
export async function setOrderArchived(
  userId: string,
  orderId: string,
  archived: boolean,
  reason: string,
  key: string,
) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin.rpc("admin_set_order_archived", {
    p_actor: userId,
    p_order_id: orderId,
    p_archived: archived,
    p_reason: reason,
    p_idempotency_key: key,
  });
  if (error) throw error;
  return data as unknown as { changed: boolean; archived: boolean };
}

export type EftConfirmOutcome =
  | "confirmed"
  | "pending_approval"
  | "amount_mismatch"
  | "order_total_changed"
  | "already_processed"
  | "paid_after_cancel_needs_refund"
  | "stock_unavailable_needs_refund"
  | "order_not_found";

/**
 * Manual EFT is a CONTROLLED workflow: manager+ only, amount and bank reference are validated and compared
 * to the order's payable total by the database, each bank reference is single-use, large amounts need a
 * second manager (dual control), and every step is audited. Budtenders can no longer confirm EFTs.
 */
export async function confirmOrderPayment(
  userId: string,
  orderId: string,
  bankReference: string,
  amountReceived: number,
) {
  const { submitEft } = await import("@/lib/payments/payments-data.server");
  const r = await submitEft(userId, orderId, bankReference, amountReceived);
  return {
    outcome: r.outcome as EftConfirmOutcome,
    duplicate: r.replayed === true,
    order_id: orderId,
  };
}

export async function listFulfilmentQueue(userId: string) {
  await assertRole(userId, "budtender");
  return loadOrders({
    limit: MAX_PAGE_SIZE,
    statuses: ["confirmed", "packing", "ready", "out_for_delivery"],
  });
}

/** The shop's catalogue: every active product sold online, with whether it is in stock. Read in pages so a large
 * catalogue is never cut off at the API's row limit. */
export async function listStoreProducts() {
  const PAGE = 1000;
  const rows: NonNullable<Awaited<ReturnType<typeof readPage>>["data"]> = [];
  const readPage = (from: number) =>
    supabaseAdmin
      .from("products")
      .select(
        "id,slug,name,category,subcategory,strain_type,price_rand,regular_price_rand,unit,badge,description,is_active,sort_order,image_path,sold_by_weight",
      )
      .eq("is_active", true)
      .eq("sell_online", true)
      .order("sort_order")
      .order("name")
      .order("id")
      .range(from, from + PAGE - 1);
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await readPage(from);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  const stock = await supabaseAdmin.from("inventory_availability").select("product_id,available");
  const available = new Map((stock.data ?? []).map((s) => [s.product_id, Number(s.available)]));
  return rows.map((p) => ({
    ...p,
    price_rand: Number(p.price_rand),
    regular_price_rand: p.regular_price_rand == null ? null : Number(p.regular_price_rand),
    in_stock: (available.get(p.id) ?? 0) > 0,
    image_url: productImageUrl(p.image_path),
  }));
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

/** Public: the homepage's featured products and categories, from the live catalogue (online, active, in stock). */
export async function getHomeCatalogue() {
  const { pickFeatured, visibleCategories } = await import("@/lib/home-catalogue");
  const [{ data, error }, stock] = await Promise.all([
    supabaseAdmin
      .from("products")
      .select(
        "id,slug,name,category,subcategory,price_rand,regular_price_rand,unit,badge,sold_by_weight,image_path,is_featured,sort_order",
      )
      .eq("is_active", true)
      .eq("sell_online", true),
    supabaseAdmin.from("inventory_availability").select("product_id,available"),
  ]);
  if (error) throw error;
  const available = new Map((stock.data ?? []).map((s) => [s.product_id, Number(s.available)]));
  const products = (data ?? []).map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    category: p.category,
    subcategory: p.subcategory,
    price_rand: Number(p.price_rand),
    regular_price_rand: p.regular_price_rand == null ? null : Number(p.regular_price_rand),
    unit: p.unit,
    badge: p.badge,
    sold_by_weight: p.sold_by_weight,
    image_url: productImageUrl(p.image_path),
    is_featured: p.is_featured,
    sort_order: p.sort_order,
    in_stock: (available.get(p.id) ?? 0) > 0,
  }));
  return { featured: pickFeatured(products), categories: visibleCategories(products) };
}
