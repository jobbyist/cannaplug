import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Static guardrails for the clinical document system. These do not replace the behavioural tests; they stop
 * the architecture drifting: AI never touches clinical data, no reusable signature image exists, nothing
 * clinical is cached in the browser or logged, and no markup is injected.
 */

const root = process.cwd();
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const read = (p: string) => readFileSync(p, "utf8");

const CLINICAL_FILES = [
  ...walk(join(root, "src/lib/clinical")),
  ...walk(join(root, "src/components/clinical")),
  join(root, "src/components/admin/ClinicalDocsPanel.tsx"),
  join(root, "src/routes/doctor.tsx"),
  join(root, "src/routes/member.documents.tsx"),
  join(root, "src/routes/verify.$token.tsx"),
  join(root, "src/routes/api/public/signatures/webhook.ts"),
];
const MIGRATION = read(join(root, "supabase/migrations/20261002001000_clinical_documents.sql"));

describe("AI restrictions", () => {
  it("no clinical code imports or calls an AI gateway, the chat assistant or an LLM", () => {
    for (const f of CLINICAL_FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(
        /ai-gateway|cannaplug-brain|chat\.functions|cannaplug-chat|LOVABLE_API_KEY|anthropic|openai|gemini|\bllm\b|chat\/completions/i,
      );
    }
  });

  it("the assistant and the chat edge function never reference clinical tables", () => {
    const sources = [
      read(join(root, "src/lib/cannaplug-brain.server.ts")),
      read(join(root, "src/lib/ai-gateway.server.ts")),
      read(join(root, "src/lib/chat.functions.ts")),
      read(join(root, "supabase/functions/cannaplug-chat/index.ts")),
    ].join("\n");
    expect(sources).not.toMatch(
      /medical_documents|prescription_orders|doctor_profiles|document_templates|document_signatures|clinical_document/,
    );
  });

  it("the assistant's own instructions still forbid dosing and medical advice", () => {
    expect(read(join(root, "supabase/functions/cannaplug-chat/index.ts"))).toMatch(
      /never provide dosing or medical advice/i,
    );
  });
});

describe("no reusable signature image", () => {
  it("the schema has no signature image/file column and no signature storage", () => {
    expect(MIGRATION).not.toMatch(/signature_(image|png|jpg|url|file|blob)|signature_data/i);
    expect(MIGRATION).not.toMatch(/'signatures'/);
  });
  it("the PDF renderer never embeds an image", () => {
    expect(read(join(root, "src/lib/clinical/pdf.server.ts"))).not.toMatch(
      /embedPng|embedJpg|drawImage/,
    );
  });
  it("the signature always comes from a per-document provider call, never from the template or profile", () => {
    const docs = read(join(root, "src/lib/clinical/documents-data.server.ts"));
    expect(docs).toMatch(/provider\.createSigningRequest/);
    expect(MIGRATION).not.toMatch(/INSERT INTO public\.document_templates[^;]*signature/i);
  });
});

describe("no clinical data in the browser, logs or analytics", () => {
  const CLIENT = CLINICAL_FILES.filter((f) => f.endsWith(".tsx"));
  it("client components never use browser storage or analytics", () => {
    for (const f of CLIENT)
      expect(read(f), f).not.toMatch(
        /localStorage|sessionStorage|indexedDB|gtag\(|posthog|mixpanel|analytics|segment\./i,
      );
  });
  it("no component injects HTML", () => {
    for (const f of CLIENT)
      expect(read(f), f).not.toMatch(
        /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|eval\(|new Function/,
      );
  });
  it("server code never logs document content, names or tokens", () => {
    for (const f of CLINICAL_FILES.filter((x) => x.endsWith(".ts"))) {
      const src = read(f);
      expect(src, f).not.toMatch(/console\.(log|info|debug)/);
      for (const m of src.matchAll(/console\.error\(([^)]*)\)/g))
        expect(m[1], f).not.toMatch(
          /rendered|content|snapshot|token|clinical|prescription|full_name|hpcsa/i,
        );
    }
  });
  it("the editor suggests nothing: no placeholders, defaults or recommended values on clinical fields", () => {
    const editor = read(join(root, "src/components/clinical/DocumentEditor.tsx"));
    expect(editor).not.toMatch(
      /placeholder=|defaultValue=|recommended|typical dose|usual dose|suggested dose/i,
    );
  });
  it("server functions never accept an actor, status, hash-to-trust or storage path from the browser", () => {
    const fns = read(join(root, "src/lib/clinical/clinical.functions.ts"));
    expect(fns).not.toMatch(/\b(actor|actorId|p_actor|storagePath|pdf_storage_path)\s*:/);
    expect(fns).not.toMatch(/status: z\.enum\(\["(DRAFT|ISSUED|SIGNED)/);
    expect(fns).toMatch(/requireSupabaseAuth/);
  });
});

describe("migration safety", () => {
  it("is additive: it drops no existing table, column, role or policy", () => {
    expect(MIGRATION).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE|SCHEMA|POLICY)/i);
    expect(MIGRATION).not.toMatch(
      /ALTER\s+TABLE\s+public\.(profiles|user_roles|orders|order_items|products|customer_verification|audit_log)\b/i,
    );
    expect(MIGRATION).not.toMatch(/ALTER\s+TYPE\s+public\.app_role/i);
  });
  it("enables RLS on every clinical table and grants no client write privilege", () => {
    const tables = [...MIGRATION.matchAll(/CREATE TABLE public\.(\w+)/g)].map((m) => m[1]!);
    expect(tables.length).toBeGreaterThanOrEqual(13);
    for (const t of tables)
      expect(MIGRATION, t).toMatch(
        new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`),
      );
    expect(MIGRATION).not.toMatch(
      /GRANT\s+(INSERT|UPDATE|DELETE|ALL|TRUNCATE)[^;]*TO\s+(authenticated|anon|PUBLIC)/i,
    );
    // The only function a client role may execute is the RLS helper.
    expect(MIGRATION).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.(?!_current_doctor_id)[^;]*TO\s+(authenticated|anon)/i,
    );
  });
  it("the storage bucket is private and PDF-only", () => {
    expect(MIGRATION).toMatch(
      /'clinical-documents', 'clinical-documents', false, 10485760, ARRAY\['application\/pdf'\]/,
    );
    expect(MIGRATION).not.toMatch(/CREATE POLICY[^;]*storage\.objects/i);
  });
  it("the legacy mirror exists and is identical", () => {
    const mirror = join(root, "drizzle/migrations/0013_clinical_documents.sql");
    expect(existsSync(mirror)).toBe(true);
    expect(read(mirror)).toBe(MIGRATION);
  });
});
