// Generates the Milestone 3 fragment of src/integrations/supabase/types.ts from the LOCAL test
// database (scripts/test-db.sh start) so the types cannot drift from the SQL. Idempotent: it
// replaces the region between the M3 markers, and adds/updates columns on existing tables.
//   node scripts/gen-m3-types.mjs
import postgres from "postgres";
import { readFileSync, writeFileSync } from "node:fs";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/cannaplug_test";
const sql = postgres(url, { onnotice: () => {} });
const TYPES = new URL("../src/integrations/supabase/types.ts", import.meta.url);

const NEW_TABLES = [
  "cash_drawers",
  "loyalty_ledger",
  "operation_idempotency",
  "payment_events",
  "pos_refund_items",
  "pos_refund_payouts",
  "pos_refunds",
  "pos_sale_items",
  "pos_sales",
  "pos_sessions",
  "pos_tenders",
  "stock_reservations",
];
const NEW_VIEWS = ["inventory_availability", "stock_movements"];
const CHANGED_TABLES = ["inventory_batches", "inventory_ledger"];

const tsType = (c) => {
  switch (c.udt_name) {
    case "uuid":
    case "text":
    case "varchar":
    case "timestamptz":
    case "timestamp":
    case "date":
    case "name":
      return "string";
    case "int2":
    case "int4":
    case "int8":
    case "numeric":
    case "float4":
    case "float8":
      return "number";
    case "bool":
      return "boolean";
    case "jsonb":
    case "json":
      return "Json";
    default:
      return "string";
  }
};

async function columns(table) {
  return sql`SELECT column_name, udt_name, is_nullable, column_default, is_generated, identity_generation
             FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}
             ORDER BY column_name`;
}

async function tableBlock(name) {
  const cols = await columns(name);
  const line = (c, opt) =>
    `          ${c.column_name}${opt ? "?" : ""}: ${tsType(c)}${c.is_nullable === "YES" ? " | null" : ""}`;
  const row = cols.map((c) => line(c, false)).join("\n");
  const ins = cols
    .map((c) =>
      line(c, c.column_default !== null || c.is_nullable === "YES" || c.identity_generation),
    )
    .join("\n");
  const upd = cols.map((c) => line(c, true)).join("\n");
  return `      ${name}: {\n        Row: {\n${row}\n        }\n        Insert: {\n${ins}\n        }\n        Update: {\n${upd}\n        }\n        Relationships: []\n      }\n`;
}

async function viewBlock(name) {
  const cols = await columns(name);
  const row = cols
    .map(
      (c) => `          ${c.column_name}: ${tsType(c)}${c.is_nullable === "YES" ? " | null" : ""}`,
    )
    .join("\n");
  return `      ${name}: {\n        Row: {\n${row}\n        }\n        Relationships: []\n      }\n`;
}

const FUNCTIONS = `      accrue_pos_loyalty: { Args: { p_sale_id: string }; Returns: Json }
      adjust_stock: {
        Args: { p_actor: string; p_batch_id: string; p_delta: number; p_idempotency_key: string; p_reason: string }
        Returns: Json
      }
      confirm_order_payment: {
        Args: { p_amount: number; p_order_id: string; p_provider: string; p_provider_event_id: string }
        Returns: Json
      }
      create_online_order: {
        Args: {
          p_contact_name: string | null
          p_contact_phone: string | null
          p_hold_minutes?: number
          p_idempotency_key: string
          p_items: Json
          p_notes: string | null
          p_user_id: string
        }
        Returns: Json
      }
      pos_close_session: {
        Args: { p_actor: string; p_actual_cash: number; p_idempotency_key: string; p_note: string | null; p_session_id: string }
        Returns: Json
      }
      pos_complete_sale: {
        Args: { p_actor: string; p_customer_id: string | null; p_idempotency_key: string; p_items: Json; p_session_id: string; p_tenders: Json }
        Returns: Json
      }
      pos_open_session: {
        Args: { p_actor: string; p_drawer_id: string; p_idempotency_key: string; p_opening_float: number }
        Returns: Json
      }
      pos_refund_sale: {
        Args: { p_actor: string; p_idempotency_key: string; p_items: Json; p_payouts: Json; p_reason: string; p_restock: boolean; p_sale_id: string; p_session_id: string }
        Returns: Json
      }
      pos_review_session: {
        Args: { p_actor: string; p_approve: boolean; p_note: string; p_session_id: string }
        Returns: Json
      }
      pos_upsert_drawer: {
        Args: { p_actor: string; p_drawer_id: string | null; p_is_active: boolean; p_location: string | null; p_name: string }
        Returns: Json
      }
      pos_void_sale: {
        Args: { p_actor: string; p_idempotency_key: string; p_reason: string; p_sale_id: string }
        Returns: Json
      }
      receive_stock: {
        Args: {
          p_actor: string
          p_batch_code: string
          p_expires_at: string | null
          p_idempotency_key: string
          p_notes: string | null
          p_product_id: string
          p_quantity: number
          p_unit_cost: number | null
        }
        Returns: Json
      }
      purge_old_idempotency_keys: { Args: { p_retain?: string }; Returns: number }
      release_expired_reservations: { Args: never; Returns: number }
      reserve_order_stock: { Args: { p_order_id: string; p_ttl_minutes?: number }; Returns: Json }
`;

let src = readFileSync(TYPES, "utf8");

// 1. strip any previous M3 regions
const strip = (s, a, b) => {
  const i = s.indexOf(a);
  if (i === -1) return s;
  const j = s.indexOf(b, i);
  return s.slice(0, i) + s.slice(j + b.length);
};
src = strip(src, "      // <m3-tables>\n", "      // </m3-tables>\n");
src = strip(src, "      // <m3-views>\n", "      // </m3-views>\n");
src = strip(src, "      // <m3-functions>\n", "      // </m3-functions>\n");

// 2. new tables before order_items (alphabetical position is irrelevant to the type system)
let tables = "";
for (const t of NEW_TABLES) tables += await tableBlock(t);
src = src.replace(
  "      order_items: {",
  `      // <m3-tables>\n${tables}      // </m3-tables>\n      order_items: {`,
);

// 3. views
let views = "";
for (const v of NEW_VIEWS) views += await viewBlock(v);
src = src.replace(
  /    Views: \{\s*(?:(?:\/\/ <m3-views>[\s\S]*?\/\/ <\/m3-views>|\[_ in never\]: never;?)\s*)?\};?/,
  `    Views: {\n      // <m3-views>\n${views}      // </m3-views>\n    };`,
);

// 4. functions
src = src.replace(
  "    Functions: {\n",
  `    Functions: {\n      // <m3-functions>\n${FUNCTIONS}      // </m3-functions>\n`,
);

// 5. changed tables: add the new columns (idempotent) to Row / Insert / Update of the existing block
const ADDED = {
  inventory_batches: [
    ["qty_held", "number", false],
    ["qty_on_hand", "number", false],
  ],
  inventory_ledger: [["movement_type", "string", true]],
};
for (const [t, cols] of Object.entries(ADDED)) {
  const re = new RegExp(`      ${t}: \\{\\n[\\s\\S]*?\\n      \\}\\n`);
  const m = src.match(re);
  if (!m) throw new Error(`table ${t} not found in types.ts`);
  let block = m[0];
  for (const [name, type, required] of cols) {
    if (block.includes(`          ${name}:`) || block.includes(`          ${name}?:`)) continue;
    block = block.replace("        Row: {\n", `        Row: {\n          ${name}: ${type}\n`);
    block = block.replace(
      "        Insert: {\n",
      `        Insert: {\n          ${name}${required ? "" : "?"}: ${type}\n`,
    );
    block = block.replace(
      "        Update: {\n",
      `        Update: {\n          ${name}?: ${type}\n`,
    );
  }
  src = src.replace(m[0], block);
}

writeFileSync(TYPES, src);
await sql.end();
console.log("types.ts updated for Milestone 3");
