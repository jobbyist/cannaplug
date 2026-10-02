// Generates the Milestone 4 fragment of src/integrations/supabase/types.ts from the LOCAL test
// database (scripts/test-db.sh start) so the types cannot drift from the SQL. Idempotent: it
// replaces the region between the M4 markers, and adds/updates columns on existing tables.
//   node scripts/gen-m3-types.mjs
import postgres from "postgres";
import { readFileSync, writeFileSync } from "node:fs";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/cannaplug_test";
const sql = postgres(url, { onnotice: () => {} });
const TYPES = new URL("../src/integrations/supabase/types.ts", import.meta.url);

// `addresses` has existed since Milestone 1 but was never added to the generated types.
const NEW_TABLES = [
  "addresses",
  "back_in_stock_subscriptions",
  "delivery_options",
  "loyalty_accounts",
  "loyalty_rules",
  "loyalty_tiers",
  "loyalty_transactions",
  "wishlist_items",
];

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
    case "_text":
      return "string[]";
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

const FUNCTIONS = `      accrue_order_loyalty: { Args: { p_order_id: string }; Returns: Json }
      checkout_place_order: {
        Args: {
          p_address_id: string
          p_contact_name: string
          p_contact_phone: string
          p_delivery_method: string
          p_expected_total: number
          p_idempotency_key: string
          p_items: Json
          p_notes: string | null
          p_payment_method: string
          p_user_id: string
        }
        Returns: Json
      }
      checkout_quote: { Args: { p_delivery_method: string; p_items: Json }; Returns: Json }
      claim_back_in_stock_notifications: { Args: { p_limit?: number }; Returns: Json }
      create_reorder: {
        Args: { p_expected_total: number; p_idempotency_key: string; p_source_order_id: string; p_user_id: string }
        Returns: Json
      }
      member_delete_address: { Args: { p_address_id: string; p_user_id: string }; Returns: Json }
      member_save_address: {
        Args: { p_address_id: string | null; p_data: Json; p_make_default?: boolean; p_user_id: string }
        Returns: Json
      }
      member_set_default_address: { Args: { p_address_id: string; p_user_id: string }; Returns: Json }
      redeem_loyalty_points: {
        Args: { p_idempotency_key: string; p_order_id: string; p_points: number; p_user_id: string }
        Returns: Json
      }
      reorder_check: { Args: { p_order_id: string; p_user_id: string }; Returns: Json }
      reverse_order_loyalty: { Args: { p_order_id: string }; Returns: Json }
`;

let src = readFileSync(TYPES, "utf8");

const strip = (s, a, b) => {
  const i = s.indexOf(a);
  if (i === -1) return s;
  const j = s.indexOf(b, i);
  return s.slice(0, i) + s.slice(j + b.length);
};
src = strip(src, "      // <m4-tables>\n", "      // </m4-tables>\n");
src = strip(src, "      // <m4-functions>\n", "      // </m4-functions>\n");

let tables = "";
for (const t of NEW_TABLES) tables += await tableBlock(t);
src = src.replace(
  "      order_items: {",
  `      // <m4-tables>\n${tables}      // </m4-tables>\n      order_items: {`,
);

src = src.replace(
  "    Functions: {\n",
  `    Functions: {\n      // <m4-functions>\n${FUNCTIONS}      // </m4-functions>\n`,
);

// orders gained the redemption columns (idempotent).
const ADDED = {
  orders: [
    ["delivery_address", "Json | null", false],
    ["delivery_fee_rand", "number", false],
    ["delivery_method", "string | null", false],
    ["loyalty_discount_rand", "number", false],
    ["loyalty_points_redeemed", "number", false],
    ["payment_method", "string | null", false],
  ],
};
for (const [t, cols] of Object.entries(ADDED)) {
  const re = new RegExp(`      ${t}: \\{\\n[\\s\\S]*?\\n      \\};?\\n`);
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
console.log("types.ts updated for Milestone 4");
