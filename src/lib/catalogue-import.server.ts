import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { mapYocoExport, parseCsv, summariseImport } from "@/lib/catalogue-import";

const MAX_BYTES = 2 * 1024 * 1024;

function parse(csv: string) {
  if (csv.length > MAX_BYTES) throw new Error("That file is over 2 MB.");
  return mapYocoExport(parseCsv(csv));
}

/** Manager+: dry run. Reads the file and the current catalogue; writes nothing. */
export async function previewCatalogueImport(userId: string, csv: string) {
  await assertRole(userId, "manager");
  const parsed = parse(csv);
  const { data: existing, error } = await supabaseAdmin
    .from("products")
    .select("id,sku,name,price_rand,is_active");
  if (error) throw error;
  const bySku = new Map(
    (existing ?? []).filter((p) => p.sku).map((p) => [p.sku!.toLowerCase(), p]),
  );
  const inFile = new Set(parsed.rows.map((r) => r.sku.toLowerCase()));
  const creates = parsed.rows.filter((r) => !bySku.has(r.sku.toLowerCase())).length;
  const priceChanges = parsed.rows.filter((r) => {
    const p = bySku.get(r.sku.toLowerCase());
    return p && Number(p.price_rand) !== Number(r.price);
  }).length;
  const wouldDeactivate = (existing ?? []).filter(
    (p) => p.is_active && (!p.sku || !inFile.has(p.sku.toLowerCase())),
  );
  const hash = createHash("sha256").update(csv).digest("hex");
  const { data: done } = await supabaseAdmin
    .from("catalogue_imports")
    .select("created_at")
    .eq("file_sha256", hash)
    .maybeSingle();
  return {
    summary: summariseImport(parsed),
    creates,
    updates: parsed.rows.length - creates,
    priceChanges,
    wouldDeactivate: wouldDeactivate.map((p) => p.name),
    issues: parsed.issues,
    notes: parsed.notes,
    alreadyImportedAt: done?.created_at ?? null,
    sample: parsed.rows.slice(0, 8),
  };
}

/** Manager+: commits the import in one database transaction (idempotent per file). */
export async function commitCatalogueImport(
  userId: string,
  csv: string,
  deactivateMissing: boolean,
  key: string,
) {
  await assertRole(userId, "manager");
  const parsed = parse(csv);
  if (parsed.issues.length)
    throw new Error(`Fix the ${parsed.issues.length} problem rows before importing.`);
  const hash = createHash("sha256").update(csv).digest("hex");
  const { data, error } = await supabaseAdmin.rpc("import_catalogue", {
    p_actor: userId,
    p_rows: parsed.rows,
    p_file_sha256: hash,
    p_source: "yoco_pos",
    p_deactivate_missing: deactivateMissing,
    p_idempotency_key: key,
  });
  if (error)
    throw new Error(
      error.message.split(":")[0] === "duplicate_sku_in_file"
        ? "The file repeats a SKU."
        : error.message,
    );
  return data as {
    rows: number;
    created: number;
    updated: number;
    stocked_products: number;
    opening_units: number;
    deactivated: number;
    already_imported?: boolean;
  };
}
