import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  asUser,
  attempt,
  connect,
  failedWith,
  key,
  mkMember,
  mkUser,
  rpc,
  type Sql,
} from "./helpers";
import {
  RX_FIELDS,
  confirmPolicy,
  enrollDoctor,
  fakeRender,
  freeze,
  hex64,
  inDays,
  issue,
  mkActiveTemplate,
  mkDraft,
  mkWorld,
  schemaFor,
  todaySast,
  token,
  LETTER_CONTENT,
  RX_CONTENT,
  type World,
} from "./clinical-helpers";

/**
 * Clinical Document & Prescription System against real PostgreSQL. Browser behaviour is reproduced with
 * `asUser` (role `authenticated` + JWT subject) so RLS and column grants apply exactly as in PostgREST.
 */
describe.skipIf(!DB_URL)("clinical documents (real PostgreSQL)", () => {
  let sql: any;
  let w: World;
  let letterTpl: string;
  let rxTpl: string;

  beforeAll(async () => {
    sql = connect(20);
    w = await mkWorld(sql);
    await confirmPolicy(sql, w);
    await enrollDoctor(sql, w);
    letterTpl = await mkActiveTemplate(sql, w, "MEDICAL_LETTER");
    rxTpl = await mkActiveTemplate(sql, w, "PRESCRIPTION_ORDER");
  });
  afterAll(async () => {
    await sql.end();
  });

  const row = async (id: string) =>
    (await sql`SELECT * FROM public.medical_documents WHERE id = ${id}`)[0]!;
  const events = async (id: string) =>
    (
      await sql`SELECT event_type, actor_role FROM public.document_events WHERE document_id = ${id} ORDER BY id`
    ).map((e: any) => e.event_type as string);

  describe("practitioner profiles and verification", () => {
    it("a profile is pending until a different administrator verifies it", async () => {
      const u = await mkUser(sql, "customer");
      const d = await rpc(sql, "doctor_admin_upsert", w.admin, u, {
        first_name: "A",
        last_name: "B",
        hpcsa_number: "MP999999",
      });
      const [p] =
        await sql`SELECT verification_status FROM public.doctor_profiles WHERE id = ${d.doctor_id}`;
      expect(p!.verification_status).toBe("pending");
      const own = await attempt(
        rpc(sql, "doctor_admin_set_status", u, d.doctor_id, "verified", "x", false),
      );
      expect(failedWith(own, "forbidden")).toBe(true);
    });

    it("an administrator who is also the practitioner cannot verify their own registration", async () => {
      const a = await mkUser(sql, "admin");
      const d = await rpc(sql, "doctor_admin_upsert", a, a, {
        first_name: "A",
        last_name: "B",
        hpcsa_number: "MP888888",
      });
      const r = await attempt(
        rpc(sql, "doctor_admin_set_status", a, d.doctor_id, "verified", "x", false),
      );
      expect(failedWith(r, "self_verification_forbidden")).toBe(true);
    });

    it("a pending, suspended, revoked or inactive practitioner cannot create documents, even with an assigned patient", async () => {
      for (const status of ["pending", "suspended", "revoked"]) {
        const w2 = await mkWorld(sql);
        const t2 = await mkActiveTemplate(sql, w2, "MEDICAL_LETTER");
        await rpc(sql, "doctor_admin_set_status", w2.admin2, w2.doctorId, status, "test", false);
        const r = await attempt(
          rpc(
            sql,
            "clinical_document_create",
            w2.doctorUser,
            "MEDICAL_LETTER",
            w2.member,
            t2,
            { statement: "x" },
            {},
            null,
            token(),
            key("c"),
          ),
        );
        expect(!r.ok && r.message, status).toMatch(/verified, active practitioner/);
      }
      const w3 = await mkWorld(sql);
      const t3 = await mkActiveTemplate(sql, w3, "MEDICAL_LETTER");
      await rpc(sql, "doctor_admin_upsert", w3.admin, w3.doctorUser, { is_active: false });
      const r = await attempt(
        rpc(
          sql,
          "clinical_document_create",
          w3.doctorUser,
          "MEDICAL_LETTER",
          w3.member,
          t3,
          { statement: "x" },
          {},
          null,
          token(),
          key("c"),
        ),
      );
      expect(!r.ok && r.message).toMatch(/verified, active practitioner/);
    });

    it("a suspended practitioner cannot approve, sign or approve templates either", async () => {
      const w2 = await mkWorld(sql);
      await confirmPolicy(sql, w2);
      const t2 = await mkActiveTemplate(sql, w2, "MEDICAL_LETTER");
      const { id } = await mkDraft(sql, w2, t2, "MEDICAL_LETTER");
      const hash = await freeze(sql, w2, id);
      await rpc(sql, "clinical_document_doctor_view", w2.doctorUser, id);
      await rpc(sql, "doctor_admin_set_status", w2.admin2, w2.doctorId, "suspended", "test", false);
      const a = await attempt(
        rpc(sql, "clinical_document_decide", w2.doctorUser, id, "approve", hash, null),
      );
      expect(!a.ok && a.message).toMatch(/verified, active practitioner/);
      const s = await attempt(
        rpc(
          sql,
          "clinical_document_begin_signing",
          w2.doctorUser,
          id,
          hash,
          "internal_simple",
          hex64(),
          "r",
        ),
      );
      expect(!s.ok && s.message).toMatch(/verified, active practitioner/);
    });

    it("changing registration data sends a verified practitioner back to pending", async () => {
      const u = await mkUser(sql, "customer");
      const d = await rpc(sql, "doctor_admin_upsert", w.admin, u, {
        first_name: "R",
        last_name: "S",
        hpcsa_number: "MP666666",
      });
      await rpc(sql, "doctor_admin_set_status", w.admin, d.doctor_id, "verified", "ok", true);
      await rpc(sql, "doctor_admin_upsert", w.admin2, u, { hpcsa_number: "MP666667" });
      const [p] =
        await sql`SELECT verification_status, prescribing_authorised FROM public.doctor_profiles WHERE id = ${d.doctor_id}`;
      expect(p).toMatchObject({ verification_status: "pending", prescribing_authorised: false });
    });

    it("prescribing authorisation needs verification and is never implied by it", async () => {
      const w2 = await mkWorld(sql, { prescribing: false });
      const r = await attempt(
        rpc(
          sql,
          "clinical_document_create",
          w2.doctorUser,
          "PRESCRIPTION_ORDER",
          w2.member,
          rxTpl,
          {},
          RX_FIELDS,
          inDays(30),
          token(),
          key("c"),
        ),
      );
      expect(failedWith(r, "forbidden")).toBe(true);
    });
  });

  describe("templates", () => {
    it("the supplied wording is seeded as DRAFT (never active) and is structurally valid", async () => {
      const seeds =
        await sql`SELECT id, status, document_type, template_content, template_schema FROM public.document_templates WHERE created_by IS NULL AND version = 1`;
      expect(seeds.length).toBeGreaterThanOrEqual(2);
      expect(seeds.every((s: any) => s.status === "DRAFT")).toBe(true);
      for (const t of seeds) {
        await sql`SELECT public._template_validate(${t.document_type}, ${t.template_content}, ${sql.json(t.template_schema)})`;
        expect(t.template_content).not.toContain("SEED-PLACEHOLDER");
      }
      const letter = seeds.find((s: any) => s.document_type === "MEDICAL_LETTER");
      expect(letter.template_content).toContain("MEDICAL PRACTITIONER LETTER");
      expect(letter.template_content).toContain("{{signature.status}}");
    });

    it("any template still carrying the placeholder marker can never be activated", async () => {
      const content = LETTER_CONTENT + "\n[[SEED-PLACEHOLDER]]";
      const t = await rpc(
        sql,
        "template_create",
        w.admin,
        "MEDICAL_LETTER",
        `Marker ${key("n")}`,
        content,
        schemaFor(content),
        null,
      );
      await rpc(sql, "template_submit", w.admin, t.template_id);
      const r = await attempt(
        rpc(sql, "template_decide", w.doctorUser, t.template_id, true, "ok", null),
      );
      expect(failedWith(r, "template_placeholder")).toBe(true);
    });

    it("a letter of fixed wording needs no clinical field, and a prescription need not print the expiry", async () => {
      const fixed =
        "Letter {{document.document_id}} {{member.full_name}} {{doctor.full_name}} {{doctor.hpcsa_number}} {{signature.status}} {{document.verification_url}}";
      await expect(
        rpc(
          sql,
          "template_create",
          w.admin,
          "MEDICAL_LETTER",
          `Fixed ${key("n")}`,
          fixed,
          schemaFor(fixed),
          null,
        ),
      ).resolves.toBeTruthy();
      const rx = RX_CONTENT.replaceAll("valid until {{document.expiry_date}}", "");
      await expect(
        rpc(
          sql,
          "template_create",
          w.admin,
          "PRESCRIPTION_ORDER",
          `NoExp ${key("n")}`,
          rx,
          schemaFor(rx),
          null,
        ),
      ).resolves.toBeTruthy();
    });

    it("an administrator cannot approve wording; only a verified practitioner can", async () => {
      const content = LETTER_CONTENT;
      const t = await rpc(
        sql,
        "template_create",
        w.admin,
        "MEDICAL_LETTER",
        `Adm ${key("n")}`,
        content,
        schemaFor(content),
        null,
      );
      await rpc(sql, "template_submit", w.admin, t.template_id);
      const r = await attempt(
        rpc(sql, "template_decide", w.admin, t.template_id, true, "ok", null),
      );
      expect(failedWith(r, "forbidden")).toBe(true);
    });

    it("a prescription template needs a prescribing-authorised practitioner to approve", async () => {
      const w2 = await mkWorld(sql, { prescribing: false });
      const content = (
        await sql`SELECT template_content c FROM public.document_templates WHERE id = ${rxTpl}`
      )[0]!.c as string;
      const t = await rpc(
        sql,
        "template_create",
        w2.admin,
        "PRESCRIPTION_ORDER",
        `Rx ${key("n")}`,
        content,
        schemaFor(content),
        null,
      );
      await rpc(sql, "template_submit", w2.admin, t.template_id);
      const r = await attempt(
        rpc(sql, "template_decide", w2.doctorUser, t.template_id, true, "ok", null),
      );
      expect(failedWith(r, "forbidden")).toBe(true);
    });

    it("an active template is never edited in place: it versions", async () => {
      const upd = await attempt(
        sql`UPDATE public.document_templates SET template_content = 'changed content that is long enough' WHERE id = ${letterTpl}`,
      );
      expect(!upd.ok && upd.message).toMatch(/immutable_record/);
      const viaRpc = await attempt(
        rpc(
          sql,
          "template_update_draft",
          w.admin,
          letterTpl,
          LETTER_CONTENT,
          schemaFor(LETTER_CONTENT),
          null,
        ),
      );
      expect(failedWith(viaRpc, "template_locked")).toBe(true);
      const v2 = await rpc(
        sql,
        "template_new_version",
        w.admin,
        letterTpl,
        LETTER_CONTENT + "\nSecond version.",
        null,
        "wording change",
      );
      expect(v2.version).toBe(2);
      // the original stays ACTIVE (and untouched) until v2 is approved
      expect(
        (await sql`SELECT status FROM public.document_templates WHERE id = ${letterTpl}`)[0]!
          .status,
      ).toBe("ACTIVE");
      await rpc(sql, "template_submit", w.admin, v2.template_id);
      await rpc(sql, "template_decide", w.doctorUser, v2.template_id, true, "ok", null);
      const rows =
        await sql`SELECT version, status FROM public.document_templates WHERE id IN (${letterTpl}, ${v2.template_id}) ORDER BY version`;
      expect(rows.map((r: any) => r.status)).toEqual(["ARCHIVED", "ACTIVE"]);
      letterTpl = v2.template_id;
    });

    it.each([
      [
        "markup",
        "Hello <script>alert(1)</script> {{document.document_id}} {{member.full_name}} {{clinical.statement}} {{doctor.full_name}} {{doctor.hpcsa_number}}",
      ],
      ["unknown placeholder", LETTER_CONTENT + " {{member.id_number}}"],
      ["unbalanced braces", LETTER_CONTENT + " {{ oops"],
    ])("rejects unsafe or invalid template content: %s", async (_n, content) => {
      const r = await attempt(
        rpc(
          sql,
          "template_create",
          w.admin,
          "MEDICAL_LETTER",
          `Bad ${key("n")}`,
          content,
          schemaFor(content.replace(/\{\{ oops/, "")),
          null,
        ),
      );
      expect(failedWith(r, "template_invalid")).toBe(true);
    });

    it("clinical placeholders must be marked required", async () => {
      const schema = schemaFor(LETTER_CONTENT);
      schema.placeholders = schema.placeholders.map((p) =>
        p.key === "clinical.statement" ? { ...p, required: false } : p,
      );
      const r = await attempt(
        rpc(
          sql,
          "template_create",
          w.admin,
          "MEDICAL_LETTER",
          `Opt ${key("n")}`,
          LETTER_CONTENT,
          schema,
          null,
        ),
      );
      expect(failedWith(r, "template_invalid")).toBe(true);
    });

    it("a prescription template must contain every mandatory prescription field", async () => {
      const content =
        "Rx {{document.document_id}} {{member.full_name}} {{doctor.full_name}} {{doctor.hpcsa_number}} {{prescription.medicine_name}} {{document.expiry_date}}";
      const r = await attempt(
        rpc(
          sql,
          "template_create",
          w.admin,
          "PRESCRIPTION_ORDER",
          `Short ${key("n")}`,
          content,
          schemaFor(content),
          null,
        ),
      );
      expect(failedWith(r, "template_invalid")).toBe(true);
    });
  });

  describe("medical letter lifecycle", () => {
    it("runs draft → review → approved → signing → signed → issued with a full audit trail", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      const done = await issue(sql, w, id);
      const doc = await row(id);
      expect(doc.status).toBe("ISSUED");
      expect(doc.document_hash).toBe(done.hash);
      expect(doc.pdf_storage_path).toBe(done.path);
      expect(await events(id)).toEqual([
        "CREATED",
        "TEMPLATE_SELECTED",
        "DATA_CAPTURED",
        "PDF_GENERATED",
        "DOCTOR_REVIEW_STARTED",
        "VIEWED",
        "DOCTOR_APPROVED",
        "SIGNATURE_REQUESTED",
        "SIGNATURE_COMPLETED",
        "ISSUED",
      ]);
      const [sig] = await sql`SELECT * FROM public.document_signatures WHERE document_id = ${id}`;
      expect(sig).toMatchObject({
        status: "COMPLETED",
        assurance_level: "SIMPLE",
        signature_provider: "internal_simple",
      });
      expect(sig!.document_hash_before_signature).toBe(done.unsigned);
      expect(sig!.document_hash_after_signature).toBe(done.after);
    });

    it("document numbers are sequential per type and year", async () => {
      const a = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      const b = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      expect(a.documentId).toMatch(/^CP-MED-\d{4}-\d{6}$/);
      expect(Number(b.documentId.slice(-6))).toBe(Number(a.documentId.slice(-6)) + 1);
    });

    it("the hash is computed by the database from the exact stored text", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      const hash = await freeze(sql, w, id);
      const [{ h }] =
        await sql`SELECT encode(sha256(convert_to(rendered_content, 'utf8')), 'hex') AS h FROM public.medical_documents WHERE id = ${id}`;
      expect(h).toBe(hash);
      expect(hash).toBe(
        (await import("node:crypto")).createHash("sha256").update(fakeRender(id)).digest("hex"),
      );
    });

    it("approval is bound to the hash the practitioner was shown", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await freeze(sql, w, id);
      await rpc(sql, "clinical_document_doctor_view", w.doctorUser, id);
      const r = await attempt(
        rpc(sql, "clinical_document_decide", w.doctorUser, id, "approve", hex64(), null),
      );
      expect(failedWith(r, "hash_mismatch")).toBe(true);
    });

    it("approval requires the document to have been opened for review", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      const hash = await freeze(sql, w, id);
      const r = await attempt(
        rpc(sql, "clinical_document_decide", w.doctorUser, id, "approve", hash, null),
      );
      expect(failedWith(r, "review_required")).toBe(true);
    });

    it("the snapshot cannot change between preparation and submission", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      const prep = await rpc(sql, "clinical_document_prepare", w.doctorUser, id, todaySast());
      await rpc(
        sql,
        "clinical_document_update_draft",
        w.doctorUser,
        id,
        { statement: "EDITED AFTER PREPARE" },
        null,
        null,
      );
      const r = await attempt(
        rpc(sql, "clinical_document_submit", w.doctorUser, id, fakeRender(id), prep.snapshot_hash),
      );
      expect(failedWith(r, "snapshot_changed")).toBe(true);
    });

    it("request-changes returns the document to DRAFT and clears the frozen text", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await freeze(sql, w, id);
      await rpc(
        sql,
        "clinical_document_decide",
        w.doctorUser,
        id,
        "request_changes",
        null,
        "fix the wording",
      );
      const d = await row(id);
      expect(d).toMatchObject({ status: "DRAFT", rendered_content: null, document_hash: null });
    });

    it("rejecting voids the document", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await freeze(sql, w, id);
      await rpc(
        sql,
        "clinical_document_decide",
        w.doctorUser,
        id,
        "reject",
        null,
        "not appropriate",
      );
      expect((await row(id)).status).toBe("VOID");
    });

    it("a letter cannot carry prescription data and a prescription cannot carry letter fields", async () => {
      const a = await attempt(
        rpc(
          sql,
          "clinical_document_create",
          w.doctorUser,
          "MEDICAL_LETTER",
          w.member,
          letterTpl,
          { statement: "s" },
          { medicine_name: "x" },
          null,
          token(),
          key("c"),
        ),
      );
      expect(failedWith(a, "invalid_input")).toBe(true);
      const b = await attempt(
        rpc(
          sql,
          "clinical_document_create",
          w.doctorUser,
          "PRESCRIPTION_ORDER",
          w.member,
          rxTpl,
          { statement: "s" },
          RX_FIELDS,
          inDays(5),
          token(),
          key("c"),
        ),
      );
      expect(failedWith(b, "invalid_input")).toBe(true);
    });

    it("rejects unknown fields, markup and oversize text", async () => {
      const bad = [{ statement: "<b>x</b>" }, { diagnosis: "x" }, { statement: "x".repeat(4001) }];
      for (const clinical of bad) {
        const r = await attempt(
          rpc(
            sql,
            "clinical_document_create",
            w.doctorUser,
            "MEDICAL_LETTER",
            w.member,
            letterTpl,
            clinical,
            {},
            null,
            token(),
            key("c"),
          ),
        );
        expect(failedWith(r, "invalid_input")).toBe(true);
      }
    });

    it("only an assigned, identity-verified member can be the subject", async () => {
      const stranger = await mkMember(sql);
      const r = await attempt(
        rpc(
          sql,
          "clinical_document_create",
          w.doctorUser,
          "MEDICAL_LETTER",
          stranger,
          letterTpl,
          { statement: "s" },
          {},
          null,
          token(),
          key("c"),
        ),
      );
      expect(failedWith(r, "forbidden")).toBe(true);
      const unverified = await mkUser(sql, "customer");
      await sql`INSERT INTO public.profiles (id, full_name, date_of_birth) VALUES (${unverified}, 'U', '1990-01-01')
                ON CONFLICT (id) DO UPDATE SET full_name = 'U', date_of_birth = '1990-01-01'`;
      const d = await rpc(sql, "doctor_assign_patient", w.admin, w.doctorId, unverified, true);
      expect(d.assigned).toBe(true);
      const r2 = await attempt(
        rpc(
          sql,
          "clinical_document_create",
          w.doctorUser,
          "MEDICAL_LETTER",
          unverified,
          letterTpl,
          { statement: "s" },
          {},
          null,
          token(),
          key("c"),
        ),
      );
      expect(failedWith(r2, "member_not_verified")).toBe(true);
    });

    it("create is idempotent for a repeated key", async () => {
      const k = key("c");
      const t = token();
      const args = [
        w.doctorUser,
        "MEDICAL_LETTER",
        w.member,
        letterTpl,
        { statement: "same" },
        {},
        null,
        t,
        k,
      ] as const;
      const a = await rpc(sql, "clinical_document_create", ...args);
      const b = await rpc(sql, "clinical_document_create", ...args);
      expect(b.id).toBe(a.id);
    });

    it("a new version supersedes the old document and gets fresh review", async () => {
      const first = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await issue(sql, w, first.id);
      await rpc(sql, "clinical_document_revoke", w.doctorUser, first.id, "correction needed");
      const r = await rpc(
        sql,
        "clinical_document_create",
        w.doctorUser,
        "MEDICAL_LETTER",
        w.member,
        letterTpl,
        { statement: "corrected" },
        {},
        null,
        token(),
        key("c"),
        first.id,
      );
      const v2 = await row(r.id);
      expect(v2).toMatchObject({
        document_version: 2,
        status: "DRAFT",
        supersedes_document_id: first.id,
      });
    });
  });

  describe("prescription workflow", () => {
    it("never invents clinical values: nothing is defaulted", async () => {
      const r = await rpc(
        sql,
        "clinical_document_create",
        w.doctorUser,
        "PRESCRIPTION_ORDER",
        w.member,
        rxTpl,
        {},
        {},
        null,
        token(),
        key("c"),
      );
      const [rx] = await sql`SELECT * FROM public.prescription_orders WHERE document_id = ${r.id}`;
      for (const f of [
        "medicine_name",
        "strength",
        "quantity_numeric",
        "quantity_words",
        "directions",
        "route",
        "frequency",
        "duration",
        "repeats",
        "indication",
        "dosage_form",
      ]) {
        expect(rx![f], f).toBeNull();
      }
    });

    it("cannot be prepared with missing practitioner-entered fields", async () => {
      const { id } = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER", {
        prescription: { medicine_name: "X" },
      });
      const r = await attempt(rpc(sql, "clinical_document_prepare", w.doctorUser, id, todaySast()));
      expect(!r.ok && r.message).toMatch(/prescription_incomplete.*strength/);
    });

    it("needs an explicit expiry and a repeat count (0 is valid, absent is not)", async () => {
      const noExpiry = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER", { expires: null });
      const r1 = await attempt(
        rpc(sql, "clinical_document_prepare", w.doctorUser, noExpiry.id, todaySast()),
      );
      expect(!r1.ok && r1.message).toMatch(/expiry_date/);
      const { repeats: _r, ...noRepeats } = RX_FIELDS;
      const d = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER", { prescription: noRepeats });
      const r2 = await attempt(
        rpc(sql, "clinical_document_prepare", w.doctorUser, d.id, todaySast()),
      );
      expect(!r2.ok && r2.message).toMatch(/repeats/);
      const ok = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER");
      await expect(
        rpc(sql, "clinical_document_prepare", w.doctorUser, ok.id, todaySast()),
      ).resolves.toBeTruthy();
    });

    it("rejects non-positive quantities and out-of-range repeats", async () => {
      for (const bad of [
        { quantity_numeric: 0 },
        { quantity_numeric: -1 },
        { repeats: -1 },
        { repeats: 100 },
      ]) {
        const r = await attempt(
          rpc(
            sql,
            "clinical_document_create",
            w.doctorUser,
            "PRESCRIPTION_ORDER",
            w.member,
            rxTpl,
            {},
            { ...RX_FIELDS, ...bad },
            inDays(5),
            token(),
            key("c"),
          ),
        );
        expect(r.ok, JSON.stringify(bad)).toBe(false);
      }
    });

    it("issues only after practitioner approval: signing, completing and issuing are refused before it", async () => {
      const { id } = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER");
      const hash = await freeze(sql, w, id);
      const sign = await attempt(
        rpc(
          sql,
          "clinical_document_begin_signing",
          w.doctorUser,
          id,
          hash,
          "external_generic",
          hex64(),
          "r",
        ),
      );
      expect(failedWith(sign, "invalid_transition")).toBe(true);
      const complete = await attempt(
        rpc(sql, "clinical_document_complete_signing", null, id, {
          signature_reference: "x",
          hash_after: hex64(),
        }),
      );
      expect(failedWith(complete, "invalid_transition")).toBe(true);
      const iss = await attempt(
        rpc(
          sql,
          "clinical_document_issue",
          null,
          id,
          `${w.member}/${id}/${crypto.randomUUID()}.pdf`,
        ),
      );
      expect(failedWith(iss, "invalid_transition")).toBe(true);
      const direct = await attempt(
        sql`UPDATE public.medical_documents SET status = 'ISSUED' WHERE id = ${id}`,
      );
      expect(!direct.ok && direct.message).toMatch(/invalid_transition/);
    });

    it("cannot be signed with a SIMPLE method", async () => {
      const { id } = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER");
      const hash = await freeze(sql, w, id);
      await rpc(sql, "clinical_document_doctor_view", w.doctorUser, id);
      await rpc(sql, "clinical_document_decide", w.doctorUser, id, "approve", hash, null);
      const r = await attempt(
        rpc(
          sql,
          "clinical_document_begin_signing",
          w.doctorUser,
          id,
          hash,
          "internal_simple",
          hex64(),
          "r",
        ),
      );
      expect(failedWith(r, "signature_level_insufficient")).toBe(true);
      const pol = await attempt(
        rpc(
          sql,
          "signature_policy_set",
          w.admin,
          "PRESCRIPTION_ORDER",
          "SIMPLE",
          "trying to weaken",
        ),
      );
      expect(!pol.ok).toBe(true);
    });

    it("an ADVANCED method needs an enrolled practitioner", async () => {
      const w2 = await mkWorld(sql, { prescribing: true });
      const t2 = await mkActiveTemplate(sql, w2, "PRESCRIPTION_ORDER");
      const { id } = await mkDraft(sql, w2, t2, "PRESCRIPTION_ORDER");
      const hash = await freeze(sql, w2, id);
      await rpc(sql, "clinical_document_doctor_view", w2.doctorUser, id);
      await rpc(sql, "clinical_document_decide", w2.doctorUser, id, "approve", hash, null);
      const r = await attempt(
        rpc(
          sql,
          "clinical_document_begin_signing",
          w2.doctorUser,
          id,
          hash,
          "external_generic",
          hex64(),
          "r",
        ),
      );
      expect(failedWith(r, "signature_not_enrolled")).toBe(true);
    });

    it("a full prescription issues with an advanced provider and freezes its prescription row", async () => {
      const { id } = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER");
      await issue(sql, w, id, "external_generic");
      const [rx] = await sql`SELECT * FROM public.prescription_orders WHERE document_id = ${id}`;
      expect(rx).toMatchObject({ status: "ISSUED" });
      expect(rx!.issue_date).toBeTruthy();
      const edit = await attempt(
        sql`UPDATE public.prescription_orders SET strength = 'CHANGED' WHERE document_id = ${id}`,
      );
      expect(!edit.ok && edit.message).toMatch(/immutable_record/);
      const viaRpc = await attempt(
        rpc(
          sql,
          "clinical_document_update_draft",
          w.doctorUser,
          id,
          null,
          { strength: "CHANGED" },
          null,
        ),
      );
      expect(failedWith(viaRpc, "document_locked")).toBe(true);
    });
  });

  describe("signing provider and policy gates", () => {
    it("an unconfirmed policy or provider blocks signing and creation", async () => {
      const w2 = await mkWorld(sql);
      const t2 = await mkActiveTemplate(sql, w2, "MEDICAL_LETTER");
      await sql`UPDATE public.document_signature_policy SET confirmed_at = NULL, confirmed_by = NULL WHERE document_type = 'MEDICAL_LETTER'`;
      const r = await attempt(
        rpc(
          sql,
          "clinical_document_create",
          w2.doctorUser,
          "MEDICAL_LETTER",
          w2.member,
          t2,
          { statement: "s" },
          {},
          null,
          token(),
          key("c"),
        ),
      );
      expect(failedWith(r, "signature_policy_unconfirmed")).toBe(true);
      await confirmPolicy(sql, w2);
      await rpc(sql, "signature_provider_set", w2.admin, "internal_simple", "SIMPLE", false, "");
      const { id } = await mkDraft(sql, w2, t2, "MEDICAL_LETTER");
      const hash = await freeze(sql, w2, id);
      await rpc(sql, "clinical_document_doctor_view", w2.doctorUser, id);
      await rpc(sql, "clinical_document_decide", w2.doctorUser, id, "approve", hash, null);
      const s = await attempt(
        rpc(
          sql,
          "clinical_document_begin_signing",
          w2.doctorUser,
          id,
          hash,
          "internal_simple",
          hex64(),
          "r",
        ),
      );
      expect(failedWith(s, "signature_provider_unavailable")).toBe(true);
      await confirmPolicy(sql, w2);
    });

    it("enabling a provider or raising its assurance requires a recorded confirmation", async () => {
      const r = await attempt(
        rpc(sql, "signature_provider_set", w.admin, "external_generic", "QUALIFIED", true, ""),
      );
      expect(failedWith(r, "confirmation_required")).toBe(true);
    });

    it("a failed signature returns the document to APPROVED and records the failure", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      const hash = await freeze(sql, w, id);
      await rpc(sql, "clinical_document_doctor_view", w.doctorUser, id);
      await rpc(sql, "clinical_document_decide", w.doctorUser, id, "approve", hash, null);
      await rpc(
        sql,
        "clinical_document_begin_signing",
        w.doctorUser,
        id,
        hash,
        "internal_simple",
        hex64(),
        "r",
      );
      await rpc(sql, "clinical_document_signing_failed", w.doctorUser, id, "provider_error");
      expect((await row(id)).status).toBe("APPROVED");
      expect(
        (await sql`SELECT status FROM public.document_signatures WHERE document_id = ${id}`)[0]!
          .status,
      ).toBe("FAILED");
      await expect(
        rpc(
          sql,
          "clinical_document_begin_signing",
          w.doctorUser,
          id,
          hash,
          "internal_simple",
          hex64(),
          "r2",
        ),
      ).resolves.toBeTruthy();
    });

    it("an unattended completion is refused for the internal attestation", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      const hash = await freeze(sql, w, id);
      await rpc(sql, "clinical_document_doctor_view", w.doctorUser, id);
      await rpc(sql, "clinical_document_decide", w.doctorUser, id, "approve", hash, null);
      await rpc(
        sql,
        "clinical_document_begin_signing",
        w.doctorUser,
        id,
        hash,
        "internal_simple",
        hex64(),
        "r",
      );
      const r = await attempt(
        rpc(sql, "clinical_document_complete_signing", null, id, {
          signature_reference: "x",
          hash_after: hex64(),
        }),
      );
      expect(failedWith(r, "forbidden")).toBe(true);
    });
  });

  describe("authorisation: who can sign what", () => {
    it("Doctor A cannot approve, sign, void or view Doctor B's document", async () => {
      const wB = await mkWorld(sql);
      await rpc(sql, "doctor_admin_set_status", wB.admin2, wB.doctorId, "verified", "ok", true);
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      const hash = await freeze(sql, w, id);
      await rpc(sql, "clinical_document_doctor_view", w.doctorUser, id);
      const approve = await attempt(
        rpc(sql, "clinical_document_decide", wB.doctorUser, id, "approve", hash, null),
      );
      expect(failedWith(approve, "forbidden")).toBe(true);
      const view = await attempt(rpc(sql, "clinical_document_doctor_view", wB.doctorUser, id));
      expect(failedWith(view, "document_not_found")).toBe(true);
      await rpc(sql, "clinical_document_decide", w.doctorUser, id, "approve", hash, null);
      const sign = await attempt(
        rpc(
          sql,
          "clinical_document_begin_signing",
          wB.doctorUser,
          id,
          hash,
          "internal_simple",
          hex64(),
          "r",
        ),
      );
      expect(failedWith(sign, "forbidden")).toBe(true);
      const voided = await attempt(rpc(sql, "clinical_document_void", wB.doctorUser, id, "nope"));
      expect(failedWith(voided, "forbidden")).toBe(true);
      const rev = await attempt(rpc(sql, "clinical_document_revoke", wB.doctorUser, id, "nope"));
      expect(rev.ok).toBe(false);
    });

    it("Doctor A cannot modify Doctor B's signed document", async () => {
      const wB = await mkWorld(sql);
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await issue(sql, w, id);
      const r = await attempt(rpc(sql, "clinical_document_revoke", wB.doctorUser, id, "malicious"));
      expect(r.ok).toBe(false);
      expect((await row(id)).status).toBe("ISSUED");
    });

    it("administrators, managers and budtenders cannot create, approve, sign or issue anything", async () => {
      const { id } = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER");
      const hash = await freeze(sql, w, id);
      for (const who of [w.admin, w.manager, w.budtender]) {
        const create = await attempt(
          rpc(
            sql,
            "clinical_document_create",
            who,
            "PRESCRIPTION_ORDER",
            w.member,
            rxTpl,
            {},
            RX_FIELDS,
            inDays(5),
            token(),
            key("c"),
          ),
        );
        expect(failedWith(create, "forbidden")).toBe(true);
        const approve = await attempt(
          rpc(sql, "clinical_document_decide", who, id, "approve", hash, null),
        );
        expect(failedWith(approve, "forbidden")).toBe(true);
        const sign = await attempt(
          rpc(
            sql,
            "clinical_document_begin_signing",
            who,
            id,
            hash,
            "external_generic",
            hex64(),
            "r",
          ),
        );
        expect(failedWith(sign, "forbidden")).toBe(true);
        const view = await attempt(rpc(sql, "clinical_document_doctor_view", who, id));
        expect(failedWith(view, "document_not_found") || failedWith(view, "forbidden")).toBe(true);
        const edit = await attempt(
          rpc(sql, "clinical_document_update_draft", who, id, null, { strength: "X" }, null),
        );
        expect(failedWith(edit, "forbidden")).toBe(true);
      }
    });

    it("only administrators run the administrative functions", async () => {
      for (const who of [w.manager, w.budtender, w.doctorUser, w.member]) {
        const a = await attempt(
          rpc(sql, "doctor_admin_upsert", who, w.member, { first_name: "X" }),
        );
        expect(failedWith(a, "forbidden")).toBe(true);
        const b = await attempt(rpc(sql, "clinical_document_admin_list", who, null, 10));
        expect(failedWith(b, "forbidden")).toBe(true);
        const c = await attempt(
          rpc(sql, "signature_policy_set", who, "MEDICAL_LETTER", "SIMPLE", "attempting to change"),
        );
        expect(failedWith(c, "forbidden")).toBe(true);
        const d = await attempt(rpc(sql, "doctor_assign_patient", who, w.doctorId, w.member, true));
        expect(failedWith(d, "forbidden")).toBe(true);
      }
    });

    it("an administrator can revoke an issued document, audited as admin, and cannot revoke a draft", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      const early = await attempt(rpc(sql, "clinical_document_revoke", w.admin, id, "too early"));
      expect(failedWith(early, "invalid_transition")).toBe(true);
      await issue(sql, w, id);
      await rpc(sql, "clinical_document_revoke", w.admin, id, "compliance request");
      const [ev] =
        await sql`SELECT actor_role FROM public.document_events WHERE document_id = ${id} AND event_type = 'REVOKED'`;
      expect(ev!.actor_role).toBe("admin");
      expect((await row(id)).status).toBe("REVOKED");
    });

    it("revocation needs a reason and a manager/budtender cannot revoke", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await issue(sql, w, id);
      expect(
        failedWith(
          await attempt(rpc(sql, "clinical_document_revoke", w.admin, id, "")),
          "invalid_input",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(rpc(sql, "clinical_document_revoke", w.manager, id, "reason here")),
          "forbidden",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(rpc(sql, "clinical_document_revoke", w.budtender, id, "reason here")),
          "forbidden",
        ),
      ).toBe(true);
    });
  });

  describe("immutability", () => {
    it("a signed/issued document cannot be modified, even by a direct write", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await issue(sql, w, id);
      for (const [label, q] of [
        [
          "rendered_content",
          sql`UPDATE public.medical_documents SET rendered_content = 'tampered' WHERE id = ${id}`,
        ],
        [
          "document_hash",
          sql`UPDATE public.medical_documents SET document_hash = ${hex64()} WHERE id = ${id}`,
        ],
        [
          "snapshot",
          sql`UPDATE public.medical_documents SET source_data_snapshot = '{}'::jsonb WHERE id = ${id}`,
        ],
        [
          "member",
          sql`UPDATE public.medical_documents SET member_id = ${w.budtender} WHERE id = ${id}`,
        ],
        [
          "pdf path",
          sql`UPDATE public.medical_documents SET pdf_storage_path = 'x/y.pdf' WHERE id = ${id}`,
        ],
        [
          "expiry",
          sql`UPDATE public.medical_documents SET expires_at = now() + interval '5 years' WHERE id = ${id}`,
        ],
        [
          "token",
          sql`UPDATE public.medical_documents SET verification_token = ${token()} WHERE id = ${id}`,
        ],
      ] as const) {
        const r = await attempt(q);
        expect(r.ok, label).toBe(false);
      }
      const unfreeze = await attempt(
        sql`UPDATE public.medical_documents SET status = 'DRAFT' WHERE id = ${id}`,
      );
      expect(!unfreeze.ok && unfreeze.message).toMatch(/invalid_transition/);
    });

    it("a stored hash that does not match its text is rejected by the database", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await freeze(sql, w, id);
      const r = await attempt(
        sql`UPDATE public.medical_documents SET document_hash = ${hex64()} WHERE id = ${id}`,
      );
      expect(!r.ok && r.message).toMatch(/immutable_record|hash_matches/);
    });

    it("signature records are never modified once resolved and never deleted", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await issue(sql, w, id);
      const upd = await attempt(
        sql`UPDATE public.document_signatures SET signature_reference = 'forged' WHERE document_id = ${id}`,
      );
      expect(!upd.ok && upd.message).toMatch(/immutable_record/);
      const del = await attempt(
        sql`DELETE FROM public.document_signatures WHERE document_id = ${id}`,
      );
      expect(!del.ok && del.message).toMatch(/retention/);
    });

    it("documents, prescriptions and practitioners are never deleted; revocation is not deletion", async () => {
      const { id } = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER");
      for (const q of [
        sql`DELETE FROM public.medical_documents WHERE id = ${id}`,
        sql`DELETE FROM public.prescription_orders WHERE document_id = ${id}`,
        sql`DELETE FROM public.doctor_profiles WHERE id = ${w.doctorId}`,
        sql`TRUNCATE public.medical_documents CASCADE`,
      ]) {
        const r = await attempt(q);
        expect(!r.ok && r.message).toMatch(/retention|permission|truncate/i);
      }
    });

    it("audit events and verification records are append-only", async () => {
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await issue(sql, w, id);
      const [{ verification_token: vt }] =
        await sql`SELECT verification_token FROM public.medical_documents WHERE id = ${id}`;
      await rpc(sql, "document_verify_record", id, vt, "VALID", hex64(), "req");
      for (const q of [
        sql`UPDATE public.document_events SET event_type = 'VOIDED' WHERE document_id = ${id}`,
        sql`DELETE FROM public.document_events WHERE document_id = ${id}`,
        sql`TRUNCATE public.document_events`,
        sql`UPDATE public.document_verifications SET verification_status = 'VALID'`,
        sql`DELETE FROM public.document_verifications`,
      ]) {
        const r = await attempt(q);
        expect(!r.ok && r.message).toMatch(/immutable_record|permission/i);
      }
    });

    it("service_role cannot write the clinical tables directly (only through the functions)", async () => {
      const asService = (q: (tx: Sql) => PromiseLike<unknown>) =>
        attempt(
          sql.begin(async (tx: any) => {
            await tx`SET LOCAL ROLE service_role`;
            return q(tx as unknown as Sql);
          }),
        );
      const r = await asService(
        (tx) => tx`UPDATE public.medical_documents SET status = 'VOID' WHERE true`,
      );
      expect(!r.ok && r.message).toMatch(/permission denied/);
      const e = await asService(
        (tx) => tx`UPDATE public.document_events SET metadata = '{}'::jsonb WHERE true`,
      );
      expect(!e.ok && e.message).toMatch(/permission denied/);
    });
  });

  describe("RLS and privileges", () => {
    let docA: string; // issued to member A
    let docB: string; // issued to member B (a different member, same doctor)
    let draftA: string;
    let memberB: string;

    beforeAll(async () => {
      memberB = await mkMember(sql);
      await sql`INSERT INTO public.profiles (id, full_name, date_of_birth) VALUES (${memberB}, 'Member B', '1985-01-01')
                ON CONFLICT (id) DO UPDATE SET full_name = 'Member B', date_of_birth = '1985-01-01'`;
      await rpc(sql, "doctor_assign_patient", w.admin, w.doctorId, memberB, true);
      docA = (
        await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER", { clinical: { statement: "SECRET-A" } })
      ).id;
      await issue(sql, w, docA);
      docB = (
        await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER", {
          member: memberB,
          clinical: { statement: "SECRET-B" },
        })
      ).id;
      await issue(sql, w, docB);
      draftA = (await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER")).id;
    });

    it("Member A can read their own issued document metadata and nothing of Member B's", async () => {
      const own = await asUser(
        sql,
        w.member,
        (tx) => tx`SELECT id FROM public.medical_documents ORDER BY id`,
      );
      expect(own.map((r: any) => r.id)).toContain(docA);
      expect(own.map((r: any) => r.id)).not.toContain(docB);
      const byId = await asUser(
        sql,
        w.member,
        (tx) => tx`SELECT id FROM public.medical_documents WHERE id = ${docB}`,
      );
      expect(byId).toHaveLength(0);
    });

    it("a member cannot see their own draft or in-review documents", async () => {
      const r = await asUser(
        sql,
        w.member,
        (tx) => tx`SELECT id FROM public.medical_documents WHERE id = ${draftA}`,
      );
      expect(r).toHaveLength(0);
    });

    it("members cannot read raw clinical content, the token or the storage path", async () => {
      for (const col of [
        "source_data_snapshot",
        "rendered_content",
        "pdf_storage_path",
        "verification_token",
        "document_hash",
        "revocation_reason",
      ]) {
        const r = await attempt(
          asUser(sql, w.member, (tx) => tx.unsafe(`SELECT ${col} FROM public.medical_documents`)),
        );
        expect(!r.ok && r.message, col).toMatch(/permission denied/);
      }
      const star = await attempt(
        asUser(sql, w.member, (tx) => tx`SELECT * FROM public.medical_documents`),
      );
      expect(!star.ok && star.message).toMatch(/permission denied/);
    });

    it("members cannot write documents, prescriptions, signatures or events", async () => {
      for (const q of [
        (tx: Sql) => tx`UPDATE public.medical_documents SET status = 'VOID' WHERE id = ${docA}`,
        (tx: Sql) => tx`DELETE FROM public.medical_documents WHERE id = ${docA}`,
        (tx: Sql) =>
          tx`INSERT INTO public.document_events (document_id, actor_role, event_type) VALUES (${docA}, 'member', 'VIEWED')`,
        (tx: Sql) => tx`UPDATE public.document_signatures SET status = 'FAILED'`,
        (tx: Sql) => tx`UPDATE public.prescription_orders SET strength = 'x'`,
      ]) {
        const r = await attempt(asUser(sql, w.member, q));
        expect(!r.ok && r.message).toMatch(/permission denied/);
      }
    });

    it("members see their own signatures only, without the provider reference", async () => {
      const mine = await asUser(
        sql,
        w.member,
        (tx) => tx`SELECT document_id FROM public.document_signatures`,
      );
      expect(mine.map((r: any) => r.document_id)).toContain(docA);
      expect(mine.map((r: any) => r.document_id)).not.toContain(docB);
      const ref = await attempt(
        asUser(
          sql,
          w.member,
          (tx) => tx`SELECT signature_reference FROM public.document_signatures`,
        ),
      );
      expect(!ref.ok && ref.message).toMatch(/permission denied/);
    });

    it("members cannot read the audit trail or verification log", async () => {
      expect(
        await asUser(sql, w.member, (tx) => tx`SELECT id FROM public.document_events`),
      ).toHaveLength(0);
      expect(
        await asUser(sql, w.member, (tx) => tx`SELECT id FROM public.document_verifications`),
      ).toHaveLength(0);
    });

    it("the doctor of record sees their documents' metadata, another doctor sees none", async () => {
      const mine = await asUser(
        sql,
        w.doctorUser,
        (tx) =>
          tx`SELECT id FROM public.medical_documents WHERE id IN (${docA}, ${docB}, ${draftA})`,
      );
      expect(mine).toHaveLength(3);
      const wB = await mkWorld(sql);
      const theirs = await asUser(
        sql,
        wB.doctorUser,
        (tx) =>
          tx`SELECT id FROM public.medical_documents WHERE id IN (${docA}, ${docB}, ${draftA})`,
      );
      expect(theirs).toHaveLength(0);
      const ev = await asUser(
        sql,
        wB.doctorUser,
        (tx) => tx`SELECT id FROM public.document_events WHERE document_id = ${docA}`,
      );
      expect(ev).toHaveLength(0);
      const rx = await asUser(
        sql,
        wB.doctorUser,
        (tx) => tx`SELECT id FROM public.prescription_orders`,
      );
      expect(rx).toHaveLength(0);
    });

    it("even the doctor cannot read clinical columns through the API (only the audited function does)", async () => {
      const r = await attempt(
        asUser(
          sql,
          w.doctorUser,
          (tx) => tx`SELECT source_data_snapshot FROM public.medical_documents`,
        ),
      );
      expect(!r.ok && r.message).toMatch(/permission denied/);
    });

    it("administrators read operational metadata but never clinical content", async () => {
      const rows = await asUser(
        sql,
        w.admin,
        (tx) =>
          tx`SELECT id, status, document_type FROM public.medical_documents WHERE id IN (${docA}, ${docB})`,
      );
      expect(rows).toHaveLength(2);
      for (const col of [
        "source_data_snapshot",
        "rendered_content",
        "pdf_storage_path",
        "verification_token",
      ]) {
        const r = await attempt(
          asUser(sql, w.admin, (tx) => tx.unsafe(`SELECT ${col} FROM public.medical_documents`)),
        );
        expect(!r.ok && r.message, col).toMatch(/permission denied/);
      }
      const rx = await asUser(sql, w.admin, (tx) => tx`SELECT id FROM public.prescription_orders`);
      expect(rx).toHaveLength(0);
      const ip = await attempt(
        asUser(sql, w.admin, (tx) => tx`SELECT ip_address FROM public.document_events`),
      );
      expect(!ip.ok && ip.message).toMatch(/permission denied/);
    });

    it("an administrator cannot open the PDF or the practitioner view", async () => {
      expect(
        failedWith(
          await attempt(rpc(sql, "clinical_document_access", w.admin, docA, "VIEWED")),
          "document_not_found",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(rpc(sql, "clinical_document_doctor_view", w.admin, docA)),
          "document_not_found",
        ),
      ).toBe(true);
    });

    it("budtenders and managers have no clinical access at all", async () => {
      for (const who of [w.budtender, w.manager]) {
        for (const t of [
          "medical_documents",
          "prescription_orders",
          "document_signatures",
          "document_events",
          "document_verifications",
          "doctor_profiles",
          "document_templates",
          "doctor_patient_assignments",
        ]) {
          const rows = await asUser(sql, who, (tx) => tx.unsafe(`SELECT 1 FROM public.${t}`));
          expect(rows, `${who} ${t}`).toHaveLength(0);
        }
        expect(
          failedWith(
            await attempt(rpc(sql, "clinical_document_access", who, docA, "VIEWED")),
            "document_not_found",
          ),
        ).toBe(true);
        expect(
          failedWith(
            await attempt(rpc(sql, "clinical_document_doctor_view", who, docA)),
            "document_not_found",
          ),
        ).toBe(true);
      }
    });

    it("budtenders cannot read clinical notes in any form", async () => {
      const r = await attempt(
        asUser(
          sql,
          w.budtender,
          (tx) => tx`SELECT source_data_snapshot FROM public.medical_documents`,
        ),
      );
      expect(!r.ok && r.message).toMatch(/permission denied/);
    });

    it("anonymous visitors see nothing and can execute nothing", async () => {
      const r = await attempt(asAnon(sql, (tx) => tx`SELECT id FROM public.medical_documents`));
      expect(!r.ok && r.message).toMatch(/permission denied/);
      const f = await attempt(asAnon(sql, (tx) => tx`SELECT public.document_verify_lookup('x')`));
      expect(!f.ok && f.message).toMatch(/permission denied/);
    });

    it("no clinical function is executable by authenticated or anon", async () => {
      const fns = await sql`
        SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND (p.proname LIKE 'clinical\_document\_%' OR p.proname LIKE 'doctor\_%'
          OR p.proname LIKE 'template\_%' OR p.proname LIKE 'signature\_%' OR p.proname LIKE 'document\_verify\_%'
          OR p.proname = 'member_list_documents')
          AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))`;
      expect(fns.map((f: any) => f.proname)).toEqual([]);
    });

    it("the clinical tables expose no write privilege to client roles", async () => {
      const rows = await sql`
        SELECT table_name, privilege_type, grantee FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'service_role')
          AND table_name IN ('doctor_profiles','doctor_patient_assignments','document_templates','medical_documents',
            'prescription_orders','document_signatures','document_events','document_verifications',
            'signature_providers','document_signature_policy','document_counters','document_verify_attempts','clinical_retention_policy')
          AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES')`;
      expect(rows).toEqual([]);
    });

    it("the storage bucket, where storage exists, is private, PDF-only and has no client policy", async () => {
      const [{ has }] = await sql`SELECT to_regclass('storage.buckets') IS NOT NULL AS has`;
      if (!has) return;
      const [b] =
        await sql`SELECT public, allowed_mime_types FROM storage.buckets WHERE id = 'clinical-documents'`;
      expect(b).toMatchObject({ public: false });
      expect(b!.allowed_mime_types).toEqual(["application/pdf"]);
    });
  });

  describe("access, member and doctor reads", () => {
    it("a member can open only their own issued PDF, and the access is audited", async () => {
      const a = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      const done = await issue(sql, w, a.id);
      const memberB = await mkMember(sql);
      const ok = await rpc(
        sql,
        "clinical_document_access",
        w.member,
        a.id,
        "DOWNLOADED",
        "1.2.3.4",
        "UA",
      );
      expect(ok.path).toBe(done.path);
      expect(
        failedWith(
          await attempt(rpc(sql, "clinical_document_access", memberB, a.id, "VIEWED")),
          "document_not_found",
        ),
      ).toBe(true);
      const [ev] =
        await sql`SELECT actor_role, ip_address, user_agent FROM public.document_events WHERE document_id = ${a.id} AND event_type = 'DOWNLOADED'`;
      expect(ev).toMatchObject({ actor_role: "member", ip_address: "1.2.3.4", user_agent: "UA" });
    });

    it("a member loses file access once the document is revoked", async () => {
      const a = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await issue(sql, w, a.id);
      await rpc(sql, "clinical_document_revoke", w.doctorUser, a.id, "withdrawn");
      expect(
        failedWith(
          await attempt(rpc(sql, "clinical_document_access", w.member, a.id, "VIEWED")),
          "document_not_found",
        ),
      ).toBe(true);
      const list = await rpc(sql, "member_list_documents", w.member);
      expect(list.find((d: any) => d.id === a.id)?.status).toBe("REVOKED");
    });

    it("the member list never includes unissued documents and carries no clinical text", async () => {
      const draft = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER", {
        clinical: { statement: "PRIVATE-STATEMENT" },
      });
      const list = await rpc(sql, "member_list_documents", w.member);
      expect(list.find((d: any) => d.id === draft.id)).toBeUndefined();
      expect(JSON.stringify(list)).not.toContain("PRIVATE-STATEMENT");
    });

    it("the practitioner's patient list is limited to assigned members", async () => {
      const stranger = await mkMember(sql);
      const list = await rpc(sql, "doctor_list_patients", w.doctorUser);
      expect(list.map((p: any) => p.member_id)).toContain(w.member);
      expect(list.map((p: any) => p.member_id)).not.toContain(stranger);
      expect(
        failedWith(await attempt(rpc(sql, "doctor_list_patients", w.admin)), "forbidden"),
      ).toBe(true);
    });

    it("the administrator list and event feed carry no clinical content", async () => {
      const a = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER");
      await issue(sql, w, a.id, "external_generic");
      const list = JSON.stringify(
        await rpc(sql, "clinical_document_admin_list", w.admin, null, 500),
      );
      const evs = JSON.stringify(await rpc(sql, "clinical_document_admin_events", w.admin, 500));
      for (const secret of [
        "TEST MEDICINE",
        "TEST STRENGTH",
        "TEST DIRECTIONS",
        "TEST INDICATION",
        "Test Member",
        "1990-05-17",
        "RENDERED DOCUMENT",
      ]) {
        expect(list).not.toContain(secret);
        expect(evs).not.toContain(secret);
      }
    });

    it("audit metadata never carries free text", async () => {
      const rows =
        await sql`SELECT DISTINCT jsonb_object_keys(metadata) AS k FROM public.document_events`;
      const allowed = new Set([
        "document_type",
        "version",
        "template_id",
        "template_version",
        "stage",
        "hash",
        "provider",
        "assurance",
        "hash_after",
        "code",
        "cancelled",
        "action",
        "result",
        "channel",
      ]);
      expect(rows.map((r: any) => r.k).filter((k: string) => !allowed.has(k))).toEqual([]);
    });
  });

  describe("expiry, revocation and public verification", () => {
    it("expiry is effective immediately in lookups and the sweep records EXPIRED", async () => {
      const a = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER", { expires: inDays(1) });
      await issue(sql, w, a.id);
      await sql`ALTER TABLE public.medical_documents DISABLE TRIGGER medical_documents_guard`;
      try {
        await sql`UPDATE public.medical_documents SET expires_at = now() - interval '1 minute' WHERE id = ${a.id}`;
      } finally {
        await sql`ALTER TABLE public.medical_documents ENABLE TRIGGER medical_documents_guard`;
      }
      const [{ verification_token }] =
        await sql`SELECT verification_token FROM public.medical_documents WHERE id = ${a.id}`;
      expect((await rpc(sql, "document_verify_lookup", verification_token)).status).toBe("EXPIRED");
      const n = await rpc(sql, "clinical_document_expire_due");
      expect(n).toBeGreaterThanOrEqual(1);
      expect((await row(a.id)).status).toBe("EXPIRED");
      expect(await events(a.id)).toContain("EXPIRED");
    });

    it("an expired document cannot be re-approved and a revoked one is never valid", async () => {
      const a = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await issue(sql, w, a.id);
      const [{ verification_token: t }] =
        await sql`SELECT verification_token FROM public.medical_documents WHERE id = ${a.id}`;
      expect((await rpc(sql, "document_verify_lookup", t)).status).toBe("ISSUED");
      await rpc(sql, "clinical_document_revoke", w.doctorUser, a.id, "no longer valid");
      expect((await rpc(sql, "document_verify_lookup", t)).status).toBe("REVOKED");
      const again = await attempt(
        rpc(sql, "clinical_document_revoke", w.doctorUser, a.id, "twice"),
      );
      expect(failedWith(again, "invalid_transition")).toBe(true);
    });

    it("lookup reveals no health or identity information", async () => {
      const a = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER");
      await issue(sql, w, a.id, "external_generic");
      const [{ verification_token: t }] =
        await sql`SELECT verification_token FROM public.medical_documents WHERE id = ${a.id}`;
      const res = await rpc(sql, "document_verify_lookup", t);
      const { pdf_path: _internal, ...publicPart } = res;
      const text = JSON.stringify(publicPart);
      for (const secret of [
        "TEST MEDICINE",
        "TEST STRENGTH",
        "TEST DIRECTIONS",
        "TEST INDICATION",
        "Test Member",
        "1990-05-17",
        w.member,
        "RENDERED DOCUMENT",
        "MP0123456",
      ]) {
        expect(text).not.toContain(secret);
      }
      expect(res).toMatchObject({
        found: true,
        practitioner: "Dr Jane Smith",
        registration_verified: true,
        signature_completed: true,
        content_hash_ok: true,
      });
    });

    it("an unknown, malformed or empty token reveals nothing", async () => {
      for (const t of [token(), "short", "", "x".repeat(43) + "!", "' OR 1=1 --"]) {
        expect(await rpc(sql, "document_verify_lookup", t)).toEqual({ found: false });
      }
    });

    it("a document whose stored text no longer matches its hash is flagged by the lookup", async () => {
      const a = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await issue(sql, w, a.id);
      const [{ verification_token: t }] =
        await sql`SELECT verification_token FROM public.medical_documents WHERE id = ${a.id}`;
      // Simulate storage-level tampering that bypasses constraints and triggers, then look it up.
      const res = await sql
        .begin(async (tx: any) => {
          await tx`ALTER TABLE public.medical_documents DISABLE TRIGGER USER`;
          await tx`ALTER TABLE public.medical_documents DROP CONSTRAINT medical_documents_hash_matches_chk`;
          await tx`UPDATE public.medical_documents SET rendered_content = rendered_content || ' TAMPERED' WHERE id = ${a.id}`;
          const [r] = await tx`SELECT public.document_verify_lookup(${t}) AS r`;
          throw Object.assign(new Error("rollback"), { result: r!.r });
        })
        .catch((e: any) => e.result);
      expect(res.content_hash_ok).toBe(false);
    });

    it("verification records and events are written without health data", async () => {
      const a = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await issue(sql, w, a.id);
      const [{ verification_token: t }] =
        await sql`SELECT verification_token FROM public.medical_documents WHERE id = ${a.id}`;
      await rpc(sql, "document_verify_record", a.id, t, "VALID", hex64(), "hashed-requester");
      const [v] =
        await sql`SELECT verification_status, requester_hash FROM public.document_verifications WHERE document_id = ${a.id}`;
      expect(v).toMatchObject({ verification_status: "VALID", requester_hash: "hashed-requester" });
      expect(await events(a.id)).toContain("VERIFIED");
      const seen = await asUser(
        sql,
        w.admin,
        (tx) =>
          tx`SELECT verification_status FROM public.document_verifications WHERE document_id = ${a.id}`,
      );
      expect(seen).toHaveLength(1);
    });

    it("the verification rate limiter blocks after the limit within the window", async () => {
      const bucket = `test-${key("rl")}`;
      const results: boolean[] = [];
      for (let i = 0; i < 6; i++)
        results.push(await rpc(sql, "document_verify_rate_check", bucket, 5, 60));
      expect(results).toEqual([true, true, true, true, true, false]);
      expect(await rpc(sql, "document_verify_rate_check", `other-${bucket}`, 5, 60)).toBe(true);
    });

    it("tokens must be 43 URL-safe characters", async () => {
      const r = await attempt(
        rpc(
          sql,
          "clinical_document_create",
          w.doctorUser,
          "MEDICAL_LETTER",
          w.member,
          letterTpl,
          { statement: "s" },
          {},
          null,
          "predictable-1",
          key("c"),
        ),
      );
      expect(failedWith(r, "invalid_input")).toBe(true);
    });
  });
});
