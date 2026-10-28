// Product CSV upload / edit (CannaPlug template): pure parsing, template, export and change planning.
// Shared by the server and the tests. Nothing here touches the database; bulk_upsert_products() in SQL is the
// authority on what gets written and repeats every rule below.
//
// Rules a manager sees in the dialog:
// * sku identifies the product (case-insensitive). A new SKU creates a product.
// * A blank cell leaves that field as it is. A single "-" clears an optional field.
// * price is the normal selling price; sale_price (lower) puts the product on sale until sale_ends (optional).
// * opening_stock is used only for products that have never had stock; after that use Receive stock.

import { CATEGORY_ORDER } from "@/lib/home-catalogue";
import { normaliseRand, parseCsv, slugify } from "@/lib/catalogue-import";
import { describeDuplicate, findDuplicates, type DuplicatePool } from "@/lib/product-duplicates";

export const PRODUCT_CSV_COLUMNS = [
  "sku",
  "name",
  "category",
  "price",
  "sale_price",
  "sale_ends",
  "cost",
  "brand",
  "barcode",
  "unit",
  "sold_by_weight",
  "weight_step_g",
  "sell_online",
  "featured",
  "active",
  "description",
  "opening_stock",
] as const;
export type ProductCsvColumn = (typeof PRODUCT_CSV_COLUMNS)[number];

/** Categories a product can have. Lounge items are in-store services (no stock, never online). */
export const PRODUCT_CATEGORIES = [...CATEGORY_ORDER, "Lounge"] as const;
export const IN_STORE_CATEGORY = "Lounge";
export const MAX_CSV_ROWS = 2000;
export const EXAMPLE_SKU_PREFIX = "EXAMPLE-";
const CLEAR = "-";

/** One row of the file as a patch: a key that is absent means "leave as it is"; null means "clear". */
export type ProductPatch = {
  line: number;
  sku: string;
  name?: string;
  category?: string;
  price?: string;
  sale_price?: string | null;
  sale_ends?: string | null;
  cost?: string | null;
  brand?: string | null;
  barcode?: string | null;
  unit?: string | null;
  description?: string | null;
  sold_by_weight?: boolean;
  weight_step_g?: number;
  sell_online?: boolean;
  is_featured?: boolean;
  is_active?: boolean;
  opening_qty?: number;
};
export type CsvIssue = { line: number; sku: string; problem: string };
export type ParsedProductCsv = { rows: ProductPatch[]; issues: CsvIssue[]; notes: string[] };

/** The product as stored, in the shape the planner and the export need. */
export type ExistingProduct = {
  id: string;
  sku: string | null;
  slug: string;
  name: string;
  category: string;
  price_rand: number | string;
  regular_price_rand: number | string | null;
  sale_ends_at: string | null;
  cost_rand: number | string | null;
  brand: string | null;
  barcode: string | null;
  unit: string | null;
  description: string | null;
  sold_by_weight: boolean;
  weight_step_g: number | string;
  sell_online: boolean;
  is_featured: boolean;
  is_active: boolean;
  has_stock_history: boolean;
};

const LIMITS = { name: 160, brand: 80, unit: 24, description: 4000 } as const;
const BARCODE_RE = /^[0-9A-Za-z-]{4,48}$/;

// ---------------------------------------------------------------- cells

const TRUE = new Set(["yes", "y", "true", "1"]);
const FALSE = new Set(["no", "n", "false", "0"]);
export function parseBool(v: string): boolean | undefined {
  const s = v.trim().toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  return undefined;
}

/** "2026-11-30" or "30/11/2026" → the end of that day in South Africa (UTC+2), ISO 8601. */
export function parseSaleEnd(v: string): string | undefined {
  const s = v.trim();
  let y: number, m: number, d: number;
  let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (mt) [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else if ((mt = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)))
    [d, m, y] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}T23:59:59+02:00`;
}

/** Excel runs cells that start with = + - @ as formulas; the export prefixes them with ' and the parser strips it. */
const FORMULA_START = /^[=+\-@\t\r]/;
export function unescapeCell(v: string): string {
  return v.length > 1 && v[0] === "'" && FORMULA_START.test(v.slice(1)) ? v.slice(1) : v;
}
function escapeCell(v: string): string {
  return v.length > 1 && FORMULA_START.test(v) ? `'${v}` : v;
}
function csvField(v: string): string {
  const s = escapeCell(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows: string[][]): string {
  // BOM so Excel opens it as UTF-8; CRLF like Excel writes.
  return "\uFEFF" + rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

const headerKey = (h: string) =>
  h
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

// ---------------------------------------------------------------- parse

export function parseProductCsv(text: string): ParsedProductCsv {
  const table = parseCsv(text);
  const issues: CsvIssue[] = [];
  const notes: string[] = [];
  const [header, ...body] = table;
  if (!header)
    return { rows: [], issues: [{ line: 1, sku: "", problem: "The file is empty." }], notes };
  const keys = header.map(headerKey);
  if (!keys.includes("sku"))
    return {
      rows: [],
      issues: [
        {
          line: 1,
          sku: "",
          problem: "The first row must be the template's column names, including sku.",
        },
      ],
      notes,
    };
  const known = new Set<string>(PRODUCT_CSV_COLUMNS);
  const seenCols = new Set<string>();
  for (const k of keys) {
    if (!k) continue;
    if (seenCols.has(k))
      issues.push({ line: 1, sku: "", problem: `The column "${k}" appears twice.` });
    seenCols.add(k);
    if (!known.has(k)) notes.push(`Column "${k}" is not part of the template and was ignored.`);
  }
  if (body.length > MAX_CSV_ROWS)
    return {
      rows: [],
      issues: [{ line: 1, sku: "", problem: `The file has more than ${MAX_CSV_ROWS} rows.` }],
      notes,
    };

  const rows: ProductPatch[] = [];
  const seenSku = new Map<string, number>();
  let examples = 0;
  body.forEach((r, i) => {
    const line = i + 2;
    const cell = (k: ProductCsvColumn): string | undefined => {
      const idx = keys.indexOf(k);
      if (idx < 0) return undefined;
      const v = unescapeCell((r[idx] ?? "").trim());
      return v === "" ? undefined : v;
    };
    const sku = cell("sku") ?? "";
    const bad = (problem: string) => issues.push({ line, sku, problem });
    if (!sku) return bad("Missing SKU");
    if (sku.length > 64) return bad("SKU is longer than 64 characters");
    if (sku.toUpperCase().startsWith(EXAMPLE_SKU_PREFIX)) {
      examples++;
      return undefined;
    }
    const prev = seenSku.get(sku.toLowerCase());
    if (prev) return bad(`SKU repeated (also on line ${prev})`);
    seenSku.set(sku.toLowerCase(), line);

    const p: ProductPatch = { line, sku };
    const problems: string[] = [];
    const text = (k: "brand" | "unit" | "description", limit: number) => {
      const v = cell(k);
      if (v === undefined) return;
      if (v === CLEAR) p[k] = null;
      else if (v.length > limit) problems.push(`${k} is longer than ${limit} characters`);
      else p[k] = v;
    };
    const money = (k: "sale_price" | "cost", label: string) => {
      const v = cell(k);
      if (v === undefined) return;
      if (v === CLEAR) return void (p[k] = null);
      const n = normaliseRand(v);
      if (n === null) problems.push(`${label} is not an amount in rand`);
      else p[k] = n;
    };
    const flag = (k: "sold_by_weight" | "sell_online" | "featured" | "active") => {
      const v = cell(k);
      if (v === undefined) return;
      const b = parseBool(v);
      if (b === undefined) return void problems.push(`${k} must be yes or no`);
      if (k === "featured") p.is_featured = b;
      else if (k === "active") p.is_active = b;
      else p[k] = b;
    };

    const name = cell("name");
    if (name !== undefined) {
      if (name === CLEAR) problems.push("name cannot be cleared");
      else if (name.length > LIMITS.name)
        problems.push(`name is longer than ${LIMITS.name} characters`);
      else p.name = name;
    }
    const category = cell("category");
    if (category !== undefined) {
      const c = PRODUCT_CATEGORIES.find((x) => x.toLowerCase() === category.toLowerCase());
      if (!c)
        problems.push(`Unknown category "${category}" (use ${PRODUCT_CATEGORIES.join(", ")})`);
      else p.category = c;
    }
    const price = cell("price");
    if (price !== undefined) {
      const n = price === CLEAR ? null : normaliseRand(price);
      if (n === null)
        problems.push(
          price === CLEAR ? "price cannot be cleared" : "price is not an amount in rand",
        );
      else if (Number(n) <= 0) problems.push("price must be more than R0");
      else p.price = n;
    }
    money("sale_price", "sale_price");
    const ends = cell("sale_ends");
    if (ends !== undefined) {
      if (ends === CLEAR) p.sale_ends = null;
      else {
        const iso = parseSaleEnd(ends);
        if (!iso) problems.push("sale_ends must be a date like 2026-11-30");
        else p.sale_ends = iso;
      }
    }
    money("cost", "cost");
    text("brand", LIMITS.brand);
    const barcode = cell("barcode");
    if (barcode !== undefined) {
      if (barcode === CLEAR) p.barcode = null;
      else if (!BARCODE_RE.test(barcode))
        problems.push("barcode must be 4–48 letters, digits or dashes");
      else p.barcode = barcode;
    }
    text("unit", LIMITS.unit);
    text("description", LIMITS.description);
    flag("sold_by_weight");
    const step = cell("weight_step_g");
    if (step !== undefined) {
      const n = Number(step.replace(",", "."));
      if (n !== 1 && n !== 0.5) problems.push("weight_step_g must be 1 or 0.5");
      else p.weight_step_g = n;
    }
    flag("sell_online");
    flag("featured");
    flag("active");
    const qty = cell("opening_stock");
    if (qty !== undefined) {
      if (!/^\d{1,6}$/.test(qty)) problems.push("opening_stock must be a whole number");
      else if (Number(qty) > 0) p.opening_qty = Number(qty);
    }
    if (problems.length) return bad(problems.join("; "));
    rows.push(p);
    return undefined;
  });
  if (examples)
    notes.push(
      `${examples} example row${examples === 1 ? "" : "s"} (SKU starting EXAMPLE-) skipped.`,
    );
  return { rows, issues, notes };
}

// ---------------------------------------------------------------- resolve (mirrors SQL)

const num = (v: number | string | null | undefined) =>
  v === null || v === undefined ? null : Number(v);
const money2 = (n: number | null) => (n === null ? null : n.toFixed(2));

/** Applies the sale rules to a product: what price_rand / regular_price_rand / sale_ends_at become. */
export function resolvePricing(
  ex: Pick<ExistingProduct, "price_rand" | "regular_price_rand" | "sale_ends_at"> | null,
  p: Pick<ProductPatch, "price" | "sale_price" | "sale_ends">,
): {
  price_rand: string;
  regular_price_rand: string | null;
  sale_ends_at: string | null;
  problem?: string;
  note?: string;
} | null {
  const curRegular = ex ? (num(ex.regular_price_rand) ?? num(ex.price_rand)) : null;
  const curSale = ex && ex.regular_price_rand !== null ? num(ex.price_rand) : null;
  const regular = p.price !== undefined ? Number(p.price) : curRegular;
  if (regular === null) return null;
  const saleFromFile = p.sale_price !== undefined;
  let sale = saleFromFile ? num(p.sale_price) : curSale;
  let note: string | undefined;
  if (sale !== null && sale >= regular) {
    if (saleFromFile)
      return {
        price_rand: money2(regular)!,
        regular_price_rand: null,
        sale_ends_at: null,
        problem: "sale_price must be lower than price",
      };
    sale = null;
    note = "the sale ends because the new price is not above the sale price";
  }
  let ends: string | null = null;
  if (sale !== null) ends = p.sale_ends !== undefined ? p.sale_ends : (ex?.sale_ends_at ?? null);
  else if (p.sale_ends)
    return {
      price_rand: money2(regular)!,
      regular_price_rand: null,
      sale_ends_at: null,
      problem: "sale_ends needs a sale_price",
    };
  return {
    price_rand: money2(sale ?? regular)!,
    regular_price_rand: sale !== null ? money2(regular) : null,
    sale_ends_at: ends,
    ...(note ? { note } : {}),
  };
}

// ---------------------------------------------------------------- plan

export type FieldChange = { field: string; from: string; to: string };
export type PlannedCreate = {
  line: number;
  sku: string;
  name: string;
  category: string;
  price: string;
  opening_qty: number;
};
export type PlannedUpdate = { line: number; sku: string; name: string; changes: FieldChange[] };
export type CsvDuplicateWarning = { line: number; sku: string; name: string; problems: string[] };
export type ProductCsvPlan = {
  creates: PlannedCreate[];
  /** Rows that look like a product the shop already has (or another row in the file). Never blocks a save. */
  duplicates: CsvDuplicateWarning[];
  updates: PlannedUpdate[];
  unchanged: number;
  issues: CsvIssue[];
  notes: string[];
  /** What the server sends to bulk_upsert_products(): only rows that change something. */
  rpcRows: Record<string, unknown>[];
};

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
};
const sameMoney = (a: unknown, b: unknown) => num(a as never) === num(b as never);
const dateOnly = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" }) : null;

export function planProductCsv(
  parsed: ParsedProductCsv,
  existing: ExistingProduct[],
): ProductCsvPlan {
  const issues = [...parsed.issues];
  const notes = [...parsed.notes];
  const bySku = new Map(existing.filter((e) => e.sku).map((e) => [e.sku!.toLowerCase(), e]));
  const barcodeOwner = new Map(
    existing
      .filter((e) => e.barcode)
      .map((e) => [e.barcode!.toLowerCase(), e.sku?.toLowerCase() ?? e.id]),
  );
  const fileBarcodes = new Map<string, string>();
  const creates: PlannedCreate[] = [];
  const duplicates: CsvDuplicateWarning[] = [];
  const pool: DuplicatePool[] = existing.map((e) => ({
    id: e.id,
    name: e.name,
    category: e.category,
    sku: e.sku,
    is_active: e.is_active,
  }));
  // Rows already in the file count too, so one file cannot add the same product twice under two SKUs.
  const inFile: DuplicatePool[] = [];
  const warn = (p: ProductPatch, name: string, category: string, id: string | null) => {
    const found = findDuplicates({ id, name, category, sku: p.sku }, [...pool, ...inFile]);
    inFile.push({ id: `line-${p.line}`, name, category, sku: p.sku, is_active: true });
    if (found.length)
      duplicates.push({ line: p.line, sku: p.sku, name, problems: found.map(describeDuplicate) });
  };
  const updates: PlannedUpdate[] = [];
  const rpcRows: Record<string, unknown>[] = [];
  let unchanged = 0;

  for (const p of parsed.rows) {
    const key = p.sku.toLowerCase();
    const ex = bySku.get(key) ?? null;
    const bad = (problem: string) => issues.push({ line: p.line, sku: p.sku, problem });

    if (p.barcode) {
      const b = p.barcode.toLowerCase();
      const owner = barcodeOwner.get(b);
      const other = fileBarcodes.get(b);
      if ((owner && owner !== key) || (other && other !== key)) {
        bad(`barcode ${p.barcode} is already used by another product`);
        continue;
      }
      fileBarcodes.set(b, key);
    }

    if (!ex) {
      const missing = (["name", "category", "price"] as const).filter((k) => p[k] === undefined);
      if (missing.length) {
        bad(`new product needs ${missing.join(", ")}`);
        continue;
      }
      const pricing = resolvePricing(null, p)!;
      if (pricing.problem) {
        bad(pricing.problem);
        continue;
      }
      const lounge = p.category === IN_STORE_CATEGORY;
      if (lounge && p.sell_online === true) {
        bad("Lounge items are sold in store only (sell_online must be no)");
        continue;
      }
      if (lounge && p.opening_qty)
        notes.push(`${p.sku}: Lounge items carry no stock; opening_stock ignored`);
      creates.push({
        line: p.line,
        sku: p.sku,
        name: p.name!,
        category: p.category!,
        price: pricing.price_rand,
        opening_qty: lounge ? 0 : (p.opening_qty ?? 0),
      });
      warn(p, p.name!, p.category!, null);
      const { line: _l, ...rest } = p;
      rpcRows.push({
        ...rest,
        ...(lounge ? { opening_qty: undefined } : {}),
        slug: slugify(p.name!) || `product-${key}`,
      });
      continue;
    }

    // Existing product: work out the resulting values and keep only real changes.
    const nextCategory = p.category ?? ex.category;
    if ((ex.category === IN_STORE_CATEGORY) !== (nextCategory === IN_STORE_CATEGORY)) {
      bad("a product cannot be moved into or out of Lounge here; add it as a new product instead");
      continue;
    }
    if (nextCategory === IN_STORE_CATEGORY && p.sell_online === true) {
      bad("Lounge items are sold in store only (sell_online must be no)");
      continue;
    }
    const pricing = resolvePricing(ex, p)!;
    if (pricing.problem) {
      bad(pricing.problem);
      continue;
    }
    if (pricing.note) notes.push(`${p.sku}: ${pricing.note}`);
    const changes: FieldChange[] = [];
    const cmp = (
      field: string,
      from: unknown,
      to: unknown,
      same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null),
    ) => {
      if (!same(from, to)) changes.push({ field, from: show(from), to: show(to) });
    };
    if (p.name !== undefined) cmp("name", ex.name, p.name);
    if (p.category !== undefined) cmp("category", ex.category, p.category);
    const exRegular = num(ex.regular_price_rand) ?? num(ex.price_rand);
    const exSale = ex.regular_price_rand !== null ? num(ex.price_rand) : null;
    const newRegular = num(pricing.regular_price_rand) ?? num(pricing.price_rand);
    const newSale = pricing.regular_price_rand !== null ? num(pricing.price_rand) : null;
    cmp("price", money2(exRegular), money2(newRegular));
    cmp("sale_price", money2(exSale), money2(newSale));
    cmp("sale_ends", dateOnly(ex.sale_ends_at), dateOnly(pricing.sale_ends_at));
    if (p.cost !== undefined) cmp("cost", money2(num(ex.cost_rand)), p.cost, sameMoney);
    for (const k of ["brand", "barcode", "unit", "description"] as const)
      if (p[k] !== undefined) cmp(k, ex[k], p[k]);
    if (p.sold_by_weight !== undefined) cmp("sold_by_weight", ex.sold_by_weight, p.sold_by_weight);
    if (p.weight_step_g !== undefined)
      cmp("weight_step_g", Number(ex.weight_step_g), p.weight_step_g);
    if (p.sell_online !== undefined) cmp("sell_online", ex.sell_online, p.sell_online);
    if (p.is_featured !== undefined) cmp("featured", ex.is_featured, p.is_featured);
    if (p.is_active !== undefined) cmp("active", ex.is_active, p.is_active);

    let openingQty = p.opening_qty;
    if (openingQty && ex.has_stock_history) {
      notes.push(
        `${p.sku}: already has stock, so opening_stock ${openingQty} was ignored (use Receive stock)`,
      );
      openingQty = undefined;
    }
    if (openingQty) changes.push({ field: "opening_stock", from: "—", to: String(openingQty) });

    if (!changes.length) {
      unchanged++;
      continue;
    }
    if (changes.some((c) => c.field === "name" || c.field === "category"))
      warn(p, p.name ?? ex.name, p.category ?? ex.category, ex.id);
    else
      inFile.push({
        id: ex.id,
        name: ex.name,
        category: ex.category,
        sku: ex.sku,
        is_active: ex.is_active,
      });
    updates.push({ line: p.line, sku: ex.sku!, name: p.name ?? ex.name, changes });
    const { line: _l, opening_qty: _q, ...rest } = p;
    rpcRows.push({ ...rest, ...(openingQty ? { opening_qty: openingQty } : {}) });
  }
  // undefined keys must not reach the database as "present"
  const clean = rpcRows.map((r) =>
    Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)),
  );
  return { creates, duplicates, updates, unchanged, issues, notes, rpcRows: clean };
}

// ---------------------------------------------------------------- template + export

export function productCsvTemplate(): string {
  return toCsv([
    [...PRODUCT_CSV_COLUMNS],
    [
      "EXAMPLE-001",
      "Example Flower (Top Shelf)",
      "Flower",
      "120",
      "",
      "",
      "60",
      "House",
      "",
      "g",
      "yes",
      "1",
      "yes",
      "no",
      "yes",
      "Delete the example rows before uploading.",
      "100",
    ],
    [
      "EXAMPLE-002",
      "Example Gummies 200mg",
      "Edibles",
      "140",
      "120",
      "2026-12-31",
      "70",
      "",
      "6001234567890",
      "",
      "no",
      "",
      "yes",
      "yes",
      "yes",
      "",
      "24",
    ],
  ]);
}

export function productsToCsv(products: ExistingProduct[]): string {
  const rows = [...products]
    .filter((p) => p.sku)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    .map((p) => {
      const onSale = p.regular_price_rand !== null;
      const yn = (b: boolean) => (b ? "yes" : "no");
      return [
        p.sku!,
        p.name,
        p.category,
        money2(onSale ? num(p.regular_price_rand) : num(p.price_rand))!,
        onSale ? money2(num(p.price_rand))! : "",
        onSale ? (dateOnly(p.sale_ends_at) ?? "") : "",
        money2(num(p.cost_rand)) ?? "",
        p.brand ?? "",
        p.barcode ?? "",
        p.unit ?? "",
        yn(p.sold_by_weight),
        String(Number(p.weight_step_g)),
        yn(p.sell_online),
        yn(p.is_featured),
        yn(p.is_active),
        p.description ?? "",
        "",
      ];
    });
  return toCsv([[...PRODUCT_CSV_COLUMNS], ...rows]);
}
