import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { friendlyStaffError } from "@/lib/staff-errors";

/**
 * Stock takes, product-level quick add / remove and delivery receiving (5 Nov 2026). Every change goes through a
 * database function that re-checks the role, is idempotent and writes the ledger and the audit log; this layer only
 * checks the role first (for a clear message) and passes ids and quantities through. Errors are raised unchanged so
 * the staff-errors middleware turns them into plain sentences.
 */

type RpcRes<T> = { data: T | null; error: { message: string } | null };
function unwrap<T>(res: RpcRes<T>): T {
  if (res.error) throw res.error;
  return res.data as T;
}

export type StockTakeLine = {
  product_id: string;
  name: string;
  category: string;
  sold_by_weight: boolean;
  expected: number;
  counted: number;
  difference: number;
  counted_at: string;
  unit_cost: number | null;
};

export type StockTakeView = {
  take: {
    id: string;
    status: "open" | "posted" | "cancelled";
    note: string | null;
    category: string | null;
    started_at: string;
    closed_at: string | null;
  } | null;
  lines: StockTakeLine[];
};

/** The open count (or, if none is open, the most recent one) with its lines. Budtender and up. */
export async function getStockTake(actor: string): Promise<StockTakeView> {
  await assertRole(actor, "budtender");
  const takes = unwrap(
    await supabaseAdmin
      .from("stock_takes")
      .select("id,status,note,category,started_at,closed_at")
      .order("started_at", { ascending: false })
      .limit(1),
  ) as StockTakeView["take"][];
  const take = takes[0] ?? null;
  if (!take) return { take: null, lines: [] };
  const rows = unwrap(
    await supabaseAdmin
      .from("stock_take_lines")
      .select(
        "product_id,expected_at_count,counted_qty,counted_at,products(name,category,sold_by_weight,cost_rand)",
      )
      .eq("stock_take_id", take.id)
      .order("counted_at", { ascending: false })
      .limit(5000),
  ) as unknown as {
    product_id: string;
    expected_at_count: number;
    counted_qty: number;
    counted_at: string;
    products: {
      name: string;
      category: string;
      sold_by_weight: boolean;
      cost_rand: number | null;
    } | null;
  }[];
  return {
    take,
    lines: rows.map((r) => ({
      product_id: r.product_id,
      name: r.products?.name ?? "Unknown product",
      category: r.products?.category ?? "",
      sold_by_weight: Boolean(r.products?.sold_by_weight),
      expected: r.expected_at_count,
      counted: r.counted_qty,
      difference: r.counted_qty - r.expected_at_count,
      counted_at: r.counted_at,
      unit_cost: r.products?.cost_rand == null ? null : Number(r.products.cost_rand),
    })),
  };
}

export async function startStockTake(
  actor: string,
  input: { note: string | null; category: string | null; key: string },
) {
  await assertRole(actor, "manager");
  return unwrap(
    await supabaseAdmin.rpc("stock_take_start", {
      p_actor: actor,
      p_note: input.note,
      p_category: input.category,
      p_idempotency_key: input.key,
    }),
  );
}

export async function recordStockCount(
  actor: string,
  input: { stockTakeId: string; productId: string; counted: number; key: string },
) {
  await assertRole(actor, "budtender");
  return unwrap(
    await supabaseAdmin.rpc("stock_take_record_count", {
      p_actor: actor,
      p_stock_take_id: input.stockTakeId,
      p_product_id: input.productId,
      p_counted: input.counted,
      p_idempotency_key: input.key,
    }),
  );
}

/**
 * Saves many counts at once (the count-sheet CSV upload). Each line goes through stock_take_record_count exactly as a
 * count typed on screen does, with its own idempotency key derived from the upload's key, so a retry never counts a
 * line twice. A line that fails is reported and the others still save; a closed or missing count stops the upload.
 */
export async function recordStockCounts(
  actor: string,
  input: { stockTakeId: string; lines: { productId: string; counted: number }[]; key: string },
): Promise<{ saved: number; failed: { productId: string; problem: string }[] }> {
  await assertRole(actor, "budtender");
  let saved = 0;
  const failed: { productId: string; problem: string }[] = [];
  for (const l of input.lines) {
    const res = await supabaseAdmin.rpc("stock_take_record_count", {
      p_actor: actor,
      p_stock_take_id: input.stockTakeId,
      p_product_id: l.productId,
      p_counted: l.counted,
      p_idempotency_key: `${input.key}:${l.productId}`,
    });
    if (!res.error) {
      saved++;
      continue;
    }
    if (/stock_take_(closed|not_found)|forbidden/.test(res.error.message)) throw res.error;
    failed.push({ productId: l.productId, problem: friendlyStaffError(res.error).message });
  }
  return { saved, failed };
}

export async function postStockTake(actor: string, input: { stockTakeId: string; key: string }) {
  await assertRole(actor, "manager");
  return unwrap(
    await supabaseAdmin.rpc("stock_take_post", {
      p_actor: actor,
      p_stock_take_id: input.stockTakeId,
      p_idempotency_key: input.key,
    }),
  );
}

export async function cancelStockTake(actor: string, input: { stockTakeId: string; key: string }) {
  await assertRole(actor, "manager");
  return unwrap(
    await supabaseAdmin.rpc("stock_take_cancel", {
      p_actor: actor,
      p_stock_take_id: input.stockTakeId,
      p_idempotency_key: input.key,
    }),
  );
}

export async function quickAdjustStock(
  actor: string,
  input: { productId: string; delta: number; reason: string; key: string },
) {
  await assertRole(actor, "manager");
  return unwrap(
    await supabaseAdmin.rpc("stock_quick_adjust", {
      p_actor: actor,
      p_product_id: input.productId,
      p_delta: input.delta,
      p_reason: input.reason,
      p_idempotency_key: input.key,
    }),
  );
}

export async function receiveDelivery(
  actor: string,
  input: {
    supplier: string | null;
    reference: string | null;
    lines: {
      productId: string;
      quantity: number;
      unitCost: string | null;
      expiresOn: string | null;
    }[];
    key: string;
  },
) {
  await assertRole(actor, "manager");
  return unwrap(
    await supabaseAdmin.rpc("stock_receive_delivery", {
      p_actor: actor,
      p_supplier: input.supplier,
      p_reference: input.reference,
      p_lines: input.lines.map((l) => ({
        product_id: l.productId,
        quantity: l.quantity,
        ...(l.unitCost ? { unit_cost: l.unitCost } : {}),
        ...(l.expiresOn ? { expires_at: l.expiresOn } : {}),
      })),
      p_idempotency_key: input.key,
    }),
  );
}
