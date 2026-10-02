import { randomBytes } from "node:crypto";
import { key, mkMember, mkUser, rpc, type Sql } from "./helpers";

/** Fixtures for the clinical document tests (real PostgreSQL). */

export const token = () => randomBytes(32).toString("base64url");
export const hex64 = () => randomBytes(32).toString("hex");

export const LETTER_CONTENT = `Medical letter {{document.document_id}} dated {{document.issue_date}}
Patient: {{member.full_name}} ({{member.member_id}}), born {{member.date_of_birth}}
{{clinical.statement}}
Valid until {{document.expiry_date}}
{{doctor.title}} {{doctor.full_name}}, HPCSA {{doctor.hpcsa_number}}, practice {{doctor.practice_number}}`;

export const RX_CONTENT = `Prescription {{document.document_id}} dated {{document.issue_date}} valid until {{document.expiry_date}}
Patient: {{member.full_name}} ({{member.member_id}}), born {{member.date_of_birth}}
Medicine {{prescription.medicine_name}} {{prescription.generic_name}} {{prescription.dosage_form}} {{prescription.strength}}
Quantity {{prescription.quantity_numeric}} ({{prescription.quantity_words}}) route {{prescription.route}}
Frequency {{prescription.frequency}} for {{prescription.duration}} repeats {{prescription.repeats}}
Indication {{prescription.indication}}. Directions {{prescription.directions}}. {{prescription.special_instructions}}
{{doctor.title}} {{doctor.full_name}}, HPCSA {{doctor.hpcsa_number}}, practice {{doctor.practice_number}}`;

const OPTIONAL = new Set([
  "document.expiry_date",
  "prescription.generic_name",
  "prescription.special_instructions",
  "doctor.practice_number",
]);

export const schemaFor = (content: string) => ({
  placeholders: [
    ...new Set([...content.matchAll(/\{\{\s*([a-z_.]+)\s*\}\}/g)].map((m) => m[1]!)),
  ].map((k) => ({ key: k, required: !OPTIONAL.has(k) })),
});

export const RX_FIELDS = {
  medicine_name: "TEST MEDICINE",
  dosage_form: "TEST FORM",
  strength: "TEST STRENGTH",
  quantity_numeric: 5,
  quantity_words: "five",
  directions: "TEST DIRECTIONS",
  route: "TEST ROUTE",
  frequency: "TEST FREQUENCY",
  duration: "TEST DURATION",
  repeats: 0,
  indication: "TEST INDICATION",
};

export const inDays = (n: number) => new Date(Date.now() + n * 86400_000);
export const todaySast = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date());

export type World = Awaited<ReturnType<typeof mkWorld>>;

/** Admin + second admin + budtender + manager, a verified/prescribing doctor with an assigned member. */
export async function mkWorld(sql: Sql, opts: { prescribing?: boolean } = {}) {
  const admin = await mkUser(sql, "admin");
  const admin2 = await mkUser(sql, "admin");
  const budtender = await mkUser(sql, "budtender");
  const manager = await mkUser(sql, "manager");
  const doctorUser = await mkUser(sql, "customer");
  const member = await mkMember(sql);
  await sql`INSERT INTO public.profiles (id, full_name, date_of_birth) VALUES (${member}, 'Test Member', '1990-05-17')
            ON CONFLICT (id) DO UPDATE SET full_name = 'Test Member', date_of_birth = '1990-05-17'`;
  const d = await rpc(sql, "doctor_admin_upsert", admin, doctorUser, {
    first_name: "Jane",
    last_name: "Smith",
    title: "Dr",
    hpcsa_number: "MP0123456",
    practice_number: "PR123",
    practice_name: "Test Practice",
  });
  await rpc(
    sql,
    "doctor_admin_set_status",
    admin2,
    d.doctor_id,
    "verified",
    "checked against register",
    opts.prescribing ?? true,
  );
  await rpc(sql, "doctor_assign_patient", admin, d.doctor_id, member, true);
  return { admin, admin2, budtender, manager, doctorUser, doctorId: d.doctor_id as string, member };
}

/** Records the compliance decisions that unblock signing. ASSURANCE is the test fixture's choice. */
export async function confirmPolicy(sql: Sql, w: World, rx: "ADVANCED" | "QUALIFIED" = "ADVANCED") {
  await rpc(
    sql,
    "signature_provider_set",
    w.admin,
    "internal_simple",
    "SIMPLE",
    true,
    "test fixture confirmation",
  );
  await rpc(
    sql,
    "signature_provider_set",
    w.admin,
    "external_generic",
    rx,
    true,
    "test fixture confirmation",
  );
  await rpc(
    sql,
    "signature_policy_set",
    w.admin,
    "MEDICAL_LETTER",
    "SIMPLE",
    "test fixture confirmation",
  );
  await rpc(
    sql,
    "signature_policy_set",
    w.admin,
    "PRESCRIPTION_ORDER",
    rx,
    "test fixture confirmation",
  );
}

export async function enrollDoctor(sql: Sql, w: World, provider = "external_generic") {
  await rpc(
    sql,
    "doctor_admin_set_status",
    w.admin2,
    w.doctorId,
    "verified",
    "ok",
    true,
    "enrolled",
    provider,
    "signer-1",
  );
}

/** An ACTIVE template of the given type, approved by the doctor. */
export async function mkActiveTemplate(
  sql: Sql,
  w: World,
  type: "MEDICAL_LETTER" | "PRESCRIPTION_ORDER",
) {
  const content = type === "MEDICAL_LETTER" ? LETTER_CONTENT : RX_CONTENT;
  const name = `Test ${type} ${key("t")}`;
  const t = await rpc(
    sql,
    "template_create",
    w.admin,
    type,
    name,
    content,
    schemaFor(content),
    "fixture",
  );
  await rpc(sql, "template_submit", w.admin, t.template_id);
  await rpc(sql, "template_decide", w.doctorUser, t.template_id, true, "approved", null);
  return t.template_id as string;
}

export async function mkDraft(
  sql: Sql,
  w: World,
  templateId: string,
  type: "MEDICAL_LETTER" | "PRESCRIPTION_ORDER",
  over: { clinical?: object; prescription?: object; expires?: Date | null; member?: string } = {},
) {
  const r = await rpc(
    sql,
    "clinical_document_create",
    w.doctorUser,
    type,
    over.member ?? w.member,
    templateId,
    type === "MEDICAL_LETTER" ? (over.clinical ?? { statement: "TEST STATEMENT" }) : {},
    type === "PRESCRIPTION_ORDER" ? (over.prescription ?? RX_FIELDS) : {},
    over.expires === undefined ? inDays(90) : over.expires,
    token(),
    key("create"),
  );
  return { id: r.id as string, documentId: r.document_id as string };
}

/** Plain rendering for DB tests (the app-side engine has its own unit tests). */
export const fakeRender = (id: string) => `RENDERED DOCUMENT ${id} ${"x".repeat(60)}`;

/** DRAFT → PENDING_DOCTOR_REVIEW. Returns the frozen hash. */
export async function freeze(sql: Sql, w: World, id: string) {
  const prep = await rpc(sql, "clinical_document_prepare", w.doctorUser, id, todaySast());
  const sub = await rpc(
    sql,
    "clinical_document_submit",
    w.doctorUser,
    id,
    fakeRender(id),
    prep.snapshot_hash,
  );
  return sub.document_hash as string;
}

/** Drive a document all the way to ISSUED with the given provider. Returns ids and the hashes. */
export async function issue(
  sql: Sql,
  w: World,
  id: string,
  provider: "internal_simple" | "external_generic" = "internal_simple",
) {
  const hash = await freeze(sql, w, id);
  await rpc(sql, "clinical_document_doctor_view", w.doctorUser, id);
  await rpc(sql, "clinical_document_decide", w.doctorUser, id, "approve", hash, null);
  const unsigned = hex64();
  await rpc(
    sql,
    "clinical_document_begin_signing",
    w.doctorUser,
    id,
    hash,
    provider,
    unsigned,
    "req-1",
  );
  const after = hex64();
  await rpc(
    sql,
    "clinical_document_complete_signing",
    provider === "internal_simple" ? w.doctorUser : null,
    id,
    {
      signature_reference: "ref-1",
      hash_after: after,
    },
  );
  const rows =
    (await sql`SELECT member_id FROM public.medical_documents WHERE id = ${id}`) as unknown as {
      member_id: string;
    }[];
  const path = `${rows[0]!.member_id}/${id}/${crypto.randomUUID()}.pdf`;
  await rpc(
    sql,
    "clinical_document_issue",
    provider === "internal_simple" ? w.doctorUser : null,
    id,
    path,
  );
  return { hash, unsigned, after, path };
}
