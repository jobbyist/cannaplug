// Generates the clinical-documents fragment of src/integrations/supabase/types.ts from the LOCAL test
// database (scripts/test-db.sh start) so the types cannot drift from the SQL. Idempotent: it replaces
// the regions between the <clinical-…> markers. Run prettier on types.ts afterwards.
//   node scripts/gen-clinical-types.mjs
import postgres from "postgres";
import { readFileSync, writeFileSync } from "node:fs";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/cannaplug_test";
const sql = postgres(url, { onnotice: () => {} });
const TYPES = new URL("../src/integrations/supabase/types.ts", import.meta.url);

const TABLES = [
  "clinical_retention_policy",
  "doctor_patient_assignments",
  "doctor_profiles",
  "document_counters",
  "document_events",
  "document_signature_policy",
  "document_signatures",
  "document_templates",
  "document_verifications",
  "document_verify_attempts",
  "medical_documents",
  "prescription_orders",
  "signature_providers",
];

const FUNCTION_PATTERN =
  "^(clinical_document_|doctor_|template_|signature_|document_verify_|member_list_documents$)";

const tsType = (udt) => {
  switch (udt) {
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
    case "_text":
      return "string[]";
    default:
      return "string";
  }
};

async function tableBlock(name) {
  const cols =
    await sql`SELECT column_name, udt_name, is_nullable, column_default, identity_generation
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${name} ORDER BY column_name`;
  const line = (c, opt) =>
    `          ${c.column_name}${opt ? "?" : ""}: ${tsType(c.udt_name)}${c.is_nullable === "YES" ? " | null" : ""}`;
  const row = cols.map((c) => line(c, false)).join("\n");
  const ins = cols
    .map((c) =>
      line(c, c.column_default !== null || c.is_nullable === "YES" || c.identity_generation),
    )
    .join("\n");
  const upd = cols.map((c) => line(c, true)).join("\n");
  return `      ${name}: {\n        Row: {\n${row}\n        }\n        Insert: {\n${ins}\n        }\n        Update: {\n${upd}\n        }\n        Relationships: []\n      }\n`;
}

async function functionBlock() {
  const fns = await sql`
    SELECT p.proname, p.pronargs, p.pronargdefaults,
           pg_get_function_result(p.oid) AS result,
           COALESCE(p.proargnames, ARRAY[]::text[]) AS names,
           (SELECT array_agg(format_type(t, NULL)) FROM unnest(string_to_array(p.proargtypes::text, ' ')::oid[]) AS t) AS types
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname ~ ${FUNCTION_PATTERN} AND left(p.proname, 1) <> '_'
    ORDER BY p.proname`;
  let out = "";
  for (const f of fns) {
    const args = (f.types ?? []).map((t, i) => {
      const optional = i >= f.pronargs - f.pronargdefaults;
      const base =
        t === "boolean"
          ? "boolean"
          : /integer|numeric|bigint|smallint/.test(t)
            ? "number"
            : t === "jsonb"
              ? "Json"
              : "string";
      const ty = base === "boolean" || base === "number" ? base : `${base} | null`;
      return { name: f.names[i], optional, ty: base === "Json" ? "Json" : ty };
    });
    args.sort((a, b) => a.name.localeCompare(b.name));
    const ret =
      f.result === "void"
        ? "undefined"
        : f.result === "jsonb"
          ? "Json"
          : f.result === "integer"
            ? "number"
            : f.result === "boolean"
              ? "boolean"
              : "Json";
    const body = args.length
      ? args.map((a) => `${a.name}${a.optional ? "?" : ""}: ${a.ty}`).join("; ")
      : "";
    out += `      ${f.proname}: { Args: ${args.length ? `{ ${body} }` : "Record<PropertyKey, never>"}; Returns: ${ret} }\n`;
  }
  return out;
}

let src = readFileSync(TYPES, "utf8");
const strip = (s, a, b) => {
  const i = s.indexOf(a);
  if (i === -1) return s;
  const j = s.indexOf(b, i);
  return s.slice(0, i) + s.slice(j + b.length);
};
src = strip(src, "      // <clinical-tables>\n", "      // </clinical-tables>\n");
src = strip(src, "      // <clinical-functions>\n", "      // </clinical-functions>\n");

let tables = "";
for (const t of TABLES) tables += await tableBlock(t);
src = src.replace(
  "      order_items: {",
  `      // <clinical-tables>\n${tables}      // </clinical-tables>\n      order_items: {`,
);
src = src.replace(
  "    Functions: {\n",
  `    Functions: {\n      // <clinical-functions>\n${await functionBlock()}      // </clinical-functions>\n`,
);

writeFileSync(TYPES, src);
await sql.end();
console.log("types.ts updated for clinical documents");
