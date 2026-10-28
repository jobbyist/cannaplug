import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { assertRole } from "@/lib/admin-data.server";
import {
  parseProductCsv,
  planProductCsv,
  productsToCsv,
  type ExistingProduct,
} from "@/lib/product-csv";

const MAX_BYTES = 2 * 1024 * 1024;
const COLUMNS =
  "id,sku,slug,name,category,price_rand,regular_price_rand,sale_ends_at,cost_rand,brand,barcode,unit,description,sold_by_weight,weight_step_g,sell_online,is_featured,is_active";

/** The current catalogue in the planner's shape, including whether each product has ever had stock. */
async function loadExisting(): Promise<ExistingProduct[]> {
  const [{ data: products, error }, { data: batches, error: bErr }] = await Promise.all([
    supabaseAdmin.from("products").select(COLUMNS),
    supabaseAdmin.from("inventory_batches").select("product_id"),
  ]);
  if (error) throw error;
  if (bErr) throw bErr;
  const stocked = new Set((batches ?? []).map((b) => b.product_id));
  return (products ?? []).map(
    (p) => ({ ...p, has_stock_history: stocked.has(p.id) }) as ExistingProduct,
  );
}

function plan(csv: string, existing: ExistingProduct[]) {
  if (csv.length > MAX_BYTES) throw new Error("That file is over 2 MB.");
  return planProductCsv(parseProductCsv(csv), existing);
}

/** Manager+: the current catalogue as a CSV in the template's columns (includes cost: managers only). */
export async function exportProductsCsv(userId: string) {
  await assertRole(userId, "manager");
  const existing = await loadExisting();
  return {
    csv: productsToCsv(existing),
    products: existing.filter((p) => p.sku).length,
    withoutSku: existing.filter((p) => !p.sku).length,
  };
}

/** Manager+: dry run. Reads the file and the catalogue; writes nothing. */
export async function previewProductCsv(userId: string, csv: string) {
  await assertRole(userId, "manager");
  const p = plan(csv, await loadExisting());
  return {
    creates: p.creates,
    duplicates: p.duplicates,
    updates: p.updates,
    unchanged: p.unchanged,
    issues: p.issues,
    notes: p.notes,
  };
}

/** Manager+: re-plans against the catalogue as it is now and applies it in one database transaction. */
export async function commitProductCsv(userId: string, csv: string, key: string) {
  await assertRole(userId, "manager");
  const p = plan(csv, await loadExisting());
  if (p.issues.length) throw new Error(`Fix the ${p.issues.length} problem rows before saving.`);
  if (!p.rpcRows.length)
    return {
      rows: 0,
      created: 0,
      updated: 0,
      unchanged: p.unchanged,
      stocked_products: 0,
      opening_units: 0,
      sales_ended: 0,
    };
  const { data, error } = await supabaseAdmin.rpc("bulk_upsert_products", {
    p_actor: userId,
    p_rows: p.rpcRows as Json,
    p_file_sha256: createHash("sha256").update(csv).digest("hex"),
    p_idempotency_key: key,
  });
  if (error) throw new Error(friendly(error.message));
  return data as {
    rows: number;
    created: number;
    updated: number;
    unchanged: number;
    stocked_products: number;
    opening_units: number;
    sales_ended: number;
    replayed?: boolean;
  };
}

/** Database refusals → a sentence a manager can act on. Nothing was saved when any of these happen. */
export function friendly(message: string): string {
  const [code, sku] = message.split(":").map((s) => s.trim());
  const at = sku ? ` (${sku})` : "";
  switch (code) {
    case "barcode_in_use":
      return `A barcode is already used by another product${at}. Nothing was saved.`;
    case "sale_price_not_lower":
      return `A sale price is not lower than the price${at}. Nothing was saved.`;
    case "sale_ends_without_sale":
      return `A sale end date has no sale price${at}. Nothing was saved.`;
    case "new_product_incomplete":
      return `A new product needs a name, category and price${at}. Nothing was saved.`;
    case "lounge_in_store_only":
    case "lounge_category_change":
      return `Lounge items are in-store only and cannot be moved in or out of Lounge here${at}. Nothing was saved.`;
    case "duplicate_sku_in_file":
      return "The file repeats a SKU. Nothing was saved.";
    case "forbidden":
      return "Only managers can upload products.";
    default:
      return "The upload could not be saved, so nothing was changed. Download the products again and retry.";
  }
}
