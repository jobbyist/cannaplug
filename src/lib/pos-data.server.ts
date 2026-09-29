import type { Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";

/**
 * POS data layer. Every mutation goes through a SECURITY DEFINER PostgreSQL function that
 * re-derives prices, totals and stock in the database; nothing here (or in the browser) supplies
 * or is trusted for a price, total, stock level or actor. The actor id always comes from the
 * authenticated server-function context.
 */

export type TenderMethod = "cash" | "card" | "eft" | "paypal";

export type PosTenderInput = {
  method: TenderMethod;
  amount: string;
  reference?: string | undefined;
};
export type PosItemInput = { product_id: string; quantity: number };

export type PosCatalogItem = {
  id: string;
  slug: string;
  name: string;
  category: string;
  subcategory: string | null;
  strain_type: string | null;
  unit: string | null;
  price_rand: number;
  available: number;
};

const ERROR_MESSAGES: Record<string, string> = {
  insufficient_stock: "Not enough stock available",
  tender_mismatch: "Tenders must add up exactly to the sale total",
  session_closed: "This till session is closed",
  session_not_yours: "This till session belongs to another cashier",
  session_not_found: "Till session not found",
  drawer_already_open: "That drawer already has an open session",
  drawer_unavailable: "That drawer is not available",
  payment_reference_in_use: "That payment reference was already used on another payment",
  idempotency_conflict:
    "This request was already submitted with different details — refresh and retry",
  product_unavailable: "A product in the basket is no longer available",
  over_refund: "Refund exceeds what was sold or tendered",
  refund_mismatch: "Refund payouts must add up to the refund total",
  invalid_sale_state: "This sale can no longer be changed that way",
  reason_required: "A reason is required",
  invalid_tenders: "Invalid tender details",
  invalid_items: "Invalid basket",
  invalid_amount: "Invalid amount",
  forbidden: "You do not have permission for this action",
  not_pending: "Nothing to approve on that session",
  isolation_level: "Server configuration error (transaction isolation)",
};

/** Turns a PostgreSQL `code: detail` exception into a safe, human message (detail kept when useful). */
export function friendlyPosError(err: unknown): Error {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
  const code = /^([a-z_]+):/.exec(raw)?.[1];
  if (code && ERROR_MESSAGES[code]) {
    const detail = raw.slice(code.length + 1).trim();
    const showDetail = [
      "insufficient_stock",
      "tender_mismatch",
      "over_refund",
      "refund_mismatch",
      "invalid_sale_state",
    ].includes(code);
    return new Error(
      showDetail && detail ? `${ERROR_MESSAGES[code]} (${detail})` : ERROR_MESSAGES[code]!,
    );
  }
  if (/permission denied/i.test(raw))
    return new Error("You do not have permission for this action");
  return new Error("The action could not be completed. Please retry.");
}

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw friendlyPosError(res.error);
  return res.data as T;
}

export async function getPosOverview(userId: string) {
  const role = await assertRole(userId, "budtender");
  const isManager = role === "manager" || role === "admin";

  const [drawersRes, openRes, availabilityRes, productsRes] = await Promise.all([
    supabaseAdmin.from("cash_drawers").select("id,name,location,is_active").order("name"),
    supabaseAdmin
      .from("pos_sessions")
      .select("id,drawer_id,opened_by,opened_at,opening_float")
      .eq("status", "open"),
    supabaseAdmin.from("inventory_availability").select("product_id,available"),
    supabaseAdmin
      .from("products")
      .select("id,slug,name,category,subcategory,strain_type,unit,price_rand")
      .eq("is_active", true)
      .order("sort_order")
      .order("name"),
  ]);
  for (const r of [drawersRes, openRes, availabilityRes, productsRes])
    if (r.error) throw friendlyPosError(r.error);

  const availability = new Map(
    (availabilityRes.data ?? []).map((a) => [a.product_id, a.available]),
  );
  const catalog: PosCatalogItem[] = (productsRes.data ?? []).map((p) => ({
    ...p,
    price_rand: Number(p.price_rand),
    available: availability.get(p.id) ?? 0,
  }));

  const openSessions = openRes.data ?? [];
  const mySession = openSessions.find((s) => s.opened_by === userId) ?? null;

  let sales: PosSaleView[] = [];
  let sessionSummary: { salesCount: number; salesTotal: number } | null = null;
  if (mySession) {
    sales = await loadSales(
      supabaseAdmin
        .from("pos_sales")
        .select("*")
        .eq("session_id", mySession.id)
        .order("created_at", { ascending: false })
        .limit(50),
    );
    const live = sales.filter((s) => s.status !== "voided");
    sessionSummary = {
      salesCount: live.length,
      salesTotal: live.reduce((sum, s) => sum + s.total, 0),
    };
  }

  let pendingApprovals: {
    id: string;
    drawer_name: string;
    closed_at: string | null;
    expected_cash: number;
    actual_cash: number;
    variance: number;
    closed_by: string | null;
    cashier_name: string | null;
  }[] = [];
  if (isManager) {
    const { data, error } = await supabaseAdmin
      .from("pos_sessions")
      .select("id,drawer_id,closed_at,expected_cash,actual_cash,variance,closed_by,opened_by")
      .eq("approval_status", "pending")
      .order("closed_at", { ascending: false })
      .limit(20);
    if (error) throw friendlyPosError(error);
    const names = new Map((drawersRes.data ?? []).map((d) => [d.id, d.name]));
    const cashierIds = [...new Set((data ?? []).map((s) => s.opened_by))];
    const profiles = cashierIds.length
      ? ((await supabaseAdmin.from("profiles").select("id,full_name").in("id", cashierIds)).data ??
        [])
      : [];
    const pn = new Map(profiles.map((p) => [p.id, p.full_name]));
    pendingApprovals = (data ?? []).map((s) => ({
      id: s.id,
      drawer_name: names.get(s.drawer_id) ?? "Drawer",
      closed_at: s.closed_at,
      expected_cash: Number(s.expected_cash ?? 0),
      actual_cash: Number(s.actual_cash ?? 0),
      variance: Number(s.variance ?? 0),
      closed_by: s.closed_by,
      cashier_name: pn.get(s.opened_by) ?? null,
    }));
  }

  return {
    role,
    isManager,
    drawers: (drawersRes.data ?? []).map((d) => ({
      ...d,
      in_use: openSessions.some((s) => s.drawer_id === d.id),
    })),
    // Expected cash is deliberately NOT exposed while a session is open (blind count).
    mySession: mySession
      ? {
          id: mySession.id,
          drawer_id: mySession.drawer_id,
          opened_at: mySession.opened_at,
          opening_float: Number(mySession.opening_float),
        }
      : null,
    sessionSummary,
    sales,
    catalog,
    pendingApprovals,
  };
}

export type PosSaleView = {
  id: string;
  receipt_number: string;
  status: string;
  total: number;
  created_at: string;
  customer_id: string | null;
  items: {
    id: string;
    product_name: string;
    quantity: number;
    refunded_quantity: number;
    unit_price_rand: number;
    line_total: number;
  }[];
  tenders: { method: string; amount: number }[];
};

async function loadSales(
  query: PromiseLike<{
    data:
      | {
          id: string;
          receipt_number: string;
          status: string;
          total: number;
          created_at: string;
          customer_id: string | null;
        }[]
      | null;
    error: { message: string } | null;
  }>,
): Promise<PosSaleView[]> {
  const { data, error } = await query;
  if (error) throw friendlyPosError(error);
  const rows = data ?? [];
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [items, tenders] = await Promise.all([
    supabaseAdmin
      .from("pos_sale_items")
      .select("id,sale_id,product_name,quantity,refunded_quantity,unit_price_rand,line_total")
      .in("sale_id", ids),
    supabaseAdmin.from("pos_tenders").select("sale_id,method,amount").in("sale_id", ids),
  ]);
  if (items.error) throw friendlyPosError(items.error);
  if (tenders.error) throw friendlyPosError(tenders.error);
  return rows.map((r) => ({
    id: r.id,
    receipt_number: r.receipt_number,
    status: r.status,
    total: Number(r.total),
    created_at: r.created_at,
    customer_id: r.customer_id,
    items: (items.data ?? [])
      .filter((i) => i.sale_id === r.id)
      .map((i) => ({
        id: i.id,
        product_name: i.product_name,
        quantity: i.quantity,
        refunded_quantity: i.refunded_quantity,
        unit_price_rand: Number(i.unit_price_rand),
        line_total: Number(i.line_total),
      })),
    tenders: (tenders.data ?? [])
      .filter((t) => t.sale_id === r.id)
      .map((t) => ({ method: t.method, amount: Number(t.amount) })),
  }));
}

export async function findPosSale(userId: string, receipt: string): Promise<PosSaleView | null> {
  await assertRole(userId, "manager");
  const sales = await loadSales(
    supabaseAdmin
      .from("pos_sales")
      .select("*")
      .eq("receipt_number", receipt.trim().toUpperCase())
      .limit(1),
  );
  return sales[0] ?? null;
}

export async function posOpenSession(
  userId: string,
  drawerId: string,
  openingFloat: string,
  key: string,
) {
  return unwrap(
    await supabaseAdmin.rpc("pos_open_session", {
      p_actor: userId,
      p_drawer_id: drawerId,
      p_opening_float: Number(openingFloat),
      p_idempotency_key: key,
    }),
  );
}

export async function posCloseSession(
  userId: string,
  sessionId: string,
  actualCash: string,
  note: string | undefined,
  key: string,
) {
  return unwrap(
    await supabaseAdmin.rpc("pos_close_session", {
      p_actor: userId,
      p_session_id: sessionId,
      p_actual_cash: Number(actualCash),
      p_note: note ?? null,
      p_idempotency_key: key,
    }),
  );
}

export async function posReviewSession(
  userId: string,
  sessionId: string,
  approve: boolean,
  note: string,
) {
  return unwrap(
    await supabaseAdmin.rpc("pos_review_session", {
      p_actor: userId,
      p_session_id: sessionId,
      p_approve: approve,
      p_note: note,
    }),
  );
}

export type SaleResult = {
  sale_id: string;
  receipt_number: string;
  total: number;
  replayed?: boolean;
  items: {
    product_id: string;
    name: string;
    quantity: number;
    unit_price: number;
    line_total: number;
  }[];
  tenders: { method: string; amount: number; reference: string | null }[];
};

export type LoyaltyOutcome = {
  accrued: boolean;
  points?: number;
  reason?: string;
  pending?: boolean;
};

/**
 * Completes a sale, THEN accrues loyalty. Accrual runs only after pos_complete_sale has returned,
 * i.e. after its transaction committed. It is idempotent, so retries (and replayed duplicate
 * requests) can call it freely; a failure never fails or rolls back the sale.
 */
export async function posCompleteSale(
  userId: string,
  input: {
    sessionId: string;
    items: PosItemInput[];
    tenders: PosTenderInput[];
    customerId: string | null;
    key: string;
  },
) {
  const sale = unwrap(
    await supabaseAdmin.rpc("pos_complete_sale", {
      p_actor: userId,
      p_session_id: input.sessionId,
      p_items: input.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
      p_tenders: input.tenders.map((t) => ({
        method: t.method,
        amount: t.amount,
        ...(t.reference ? { reference: t.reference } : {}),
      })),
      p_customer_id: input.customerId,
      p_idempotency_key: input.key,
    }),
  ) as unknown as SaleResult;

  let loyalty: LoyaltyOutcome = { accrued: false, reason: "no_customer" };
  if (input.customerId) {
    try {
      loyalty = unwrap(
        await supabaseAdmin.rpc("accrue_pos_loyalty", { p_sale_id: sale.sale_id }),
      ) as unknown as LoyaltyOutcome;
    } catch (err) {
      // The sale is committed and must not fail. Accrual is idempotent and is retried by the
      // maintenance job (accrue_missing_pos_loyalty), so record the failure for operators instead.
      console.error("POS loyalty accrual failed after commit; retry job will credit it", {
        saleId: sale.sale_id,
        error: err instanceof Error ? err.message : String(err),
      });
      loyalty = { accrued: false, pending: true };
    }
  }
  return { sale, loyalty };
}

export async function posVoidSale(userId: string, saleId: string, reason: string, key: string) {
  return unwrap(
    await supabaseAdmin.rpc("pos_void_sale", {
      p_actor: userId,
      p_sale_id: saleId,
      p_reason: reason,
      p_idempotency_key: key,
    }),
  );
}

export async function posRefundSale(
  userId: string,
  input: {
    saleId: string;
    sessionId: string;
    items: { sale_item_id: string; quantity: number }[];
    payouts: { method: TenderMethod; amount: string; reference?: string | undefined }[];
    reason: string;
    restock: boolean;
    key: string;
  },
) {
  return unwrap(
    await supabaseAdmin.rpc("pos_refund_sale", {
      p_actor: userId,
      p_sale_id: input.saleId,
      p_session_id: input.sessionId,
      p_items: input.items,
      p_payouts: input.payouts.map((p) => ({
        method: p.method,
        amount: p.amount,
        ...(p.reference ? { reference: p.reference } : {}),
      })),
      p_reason: input.reason,
      p_restock: input.restock,
      p_idempotency_key: input.key,
    }),
  );
}

export async function listBatches(userId: string, productId: string) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin
    .from("inventory_batches")
    .select("id,batch_code,qty_on_hand,qty_held,expires_at,received_at")
    .eq("product_id", productId)
    .order("expires_at", { ascending: true, nullsFirst: false })
    .order("received_at");
  if (error) throw friendlyPosError(error);
  return (data ?? []).map((b) => ({ ...b, available: b.qty_on_hand - b.qty_held }));
}

export async function receiveStock(
  userId: string,
  input: {
    productId: string;
    batchCode: string;
    quantity: number;
    expiresAt: string | null;
    unitCost: string | null;
    notes: string | null;
    key: string;
  },
) {
  return unwrap(
    await supabaseAdmin.rpc("receive_stock", {
      p_actor: userId,
      p_product_id: input.productId,
      p_batch_code: input.batchCode,
      p_quantity: input.quantity,
      p_expires_at: input.expiresAt,
      p_unit_cost: input.unitCost === null ? null : Number(input.unitCost),
      p_notes: input.notes,
      p_idempotency_key: input.key,
    }),
  );
}

export async function adjustStock(
  userId: string,
  input: { batchId: string; delta: number; reason: string; key: string },
) {
  return unwrap(
    await supabaseAdmin.rpc("adjust_stock", {
      p_actor: userId,
      p_batch_id: input.batchId,
      p_delta: input.delta,
      p_reason: input.reason,
      p_idempotency_key: input.key,
    }),
  );
}

export async function upsertDrawer(
  userId: string,
  input: { drawerId: string | null; name: string; location: string | null; isActive: boolean },
) {
  return unwrap(
    await supabaseAdmin.rpc("pos_upsert_drawer", {
      p_actor: userId,
      p_drawer_id: input.drawerId,
      p_name: input.name,
      p_location: input.location,
      p_is_active: input.isActive,
    }),
  );
}
