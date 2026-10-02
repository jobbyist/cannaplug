// Generates the Milestone 5 fragment of src/integrations/supabase/types.ts from the LOCAL test
// database (scripts/test-db.sh start) so the types cannot drift from the SQL. Idempotent: it
// replaces the region between the M4 markers (ID verification, Milestone 4.2, rides in the same region), and adds/updates columns on existing tables.
//   node scripts/gen-m3-types.mjs
import postgres from "postgres";
import { readFileSync, writeFileSync } from "node:fs";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/cannaplug_test";
const sql = postgres(url, { onnotice: () => {} });
const TYPES = new URL("../src/integrations/supabase/types.ts", import.meta.url);

const NEW_TABLES = [
  "contact_submissions",
  "newsletter_subscribers",
  "fx_rates",
  "notification_events",
  "payment_settings",
  "payment_transactions",
  "webhook_events",
  "webhook_rejections",
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

const FUNCTIONS = `      contact_submit: { Args: { p_email: string; p_inbox: string; p_ip_hash: string; p_message: string; p_name: string; p_subject: string }; Returns: Json }
      newsletter_subscribe: { Args: { p_email: string; p_ip_hash: string; p_source?: string }; Returns: Json }
      newsletter_unsubscribe: { Args: { p_token: string }; Returns: Json }
      eft_approve: { Args: { p_actor: string; p_idempotency_key: string; p_transaction_id: string }; Returns: Json }
      eft_reject: { Args: { p_actor: string; p_reason: string; p_transaction_id: string }; Returns: Json }
      eft_submit: {
        Args: { p_actor: string; p_amount: number; p_bank_reference: string; p_idempotency_key: string; p_note: string | null; p_order_id: string; p_received_on: string }
        Returns: Json
      }
      fx_record_live_rate: { Args: { p_base: string; p_quote: string; p_rate: number; p_source: string; p_valid_minutes: number }; Returns: Json }
      fx_set_rate: { Args: { p_actor: string; p_base: string; p_quote: string; p_rate: number; p_source: string; p_valid_hours: number }; Returns: Json }
      notification_claim: { Args: { p_lease_seconds?: number; p_limit: number }; Returns: Database["public"]["Tables"]["notification_events"]["Row"][] }
      notification_complete: {
        Args: { p_error: string | null; p_id: string; p_ok: boolean; p_permanent?: boolean; p_provider_message_id: string | null }
        Returns: string
      }
      notification_enqueue: {
        Args: { p_category: string; p_channel: string; p_data: Json; p_dedupe_key: string; p_delay_seconds?: number; p_recipient: string; p_template: string; p_user_id: string | null }
        Returns: string
      }
      notification_enqueue_staff: { Args: { p_data: Json; p_dedupe_key: string; p_min_role?: string; p_template: string }; Returns: number }
      payment_attach_session: { Args: { p_provider_ref: string; p_redirect_url: string; p_transaction_id: string }; Returns: Json }
      payment_initiate: {
        Args: { p_idempotency_key: string; p_merchant_id: string | null; p_mode: string; p_order_id: string; p_provider: string; p_user_id: string }
        Returns: Json
      }
      payment_mark_failed: { Args: { p_reason: string; p_transaction_id: string }; Returns: undefined }
      payments_apply_verified_event: { Args: { p_event_key: string; p_event_type: string; p_facts: Json; p_payload: Json; p_provider: string }; Returns: Json }
      payments_expire_stale: { Args: Record<PropertyKey, never>; Returns: number }
      webhook_reject: { Args: { p_event_key_hint: string | null; p_ip_hash: string | null; p_provider: string; p_reason: string }; Returns: undefined }
`;

let src = readFileSync(TYPES, "utf8");

const strip = (s, a, b) => {
  const i = s.indexOf(a);
  if (i === -1) return s;
  const j = s.indexOf(b, i);
  return s.slice(0, i) + s.slice(j + b.length);
};
src = strip(src, "      // <m5-tables>\n", "      // </m5-tables>\n");
src = strip(src, "      // <m5-functions>\n", "      // </m5-functions>\n");

let tables = "";
for (const t of NEW_TABLES) tables += await tableBlock(t);
src = src.replace(
  "      // <m4-tables>\n",
  `      // <m5-tables>\n${tables}      // </m5-tables>\n      // <m4-tables>\n`,
);
src = src.replace(
  "    Functions: {\n",
  `    Functions: {\n      // <m5-functions>\n${FUNCTIONS}      // </m5-functions>\n`,
);

writeFileSync(TYPES, src);
await sql.end();
console.log("types.ts updated for Milestone 5");
