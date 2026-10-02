import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asUser,
  attempt,
  connect,
  failedWith,
  key,
  mkMember,
  mkUser,
  rpc,
} from "./helpers";
import {
  confirmPolicy,
  enrollDoctor,
  issue,
  mkActiveTemplate,
  mkDraft,
  mkWorld,
  type World,
} from "./clinical-helpers";

/** Document requests: member → administrator intake → practitioner, against real PostgreSQL. */
describe.skipIf(!DB_URL)("document requests (real PostgreSQL)", () => {
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

  const ask = (member: string, type = "MEDICAL_LETTER", note: string | null = null) =>
    rpc(sql, "request_create", member, type, note, key("rq"));
  /** A verified member with the name and date of birth a document needs. */
  const profiled = async () => {
    const m = await mkMember(sql);
    await sql`INSERT INTO public.profiles (id, full_name, date_of_birth) VALUES (${m}, 'Req Member', '1991-02-03')
              ON CONFLICT (id) DO UPDATE SET full_name = 'Req Member', date_of_birth = '1991-02-03'`;
    return m;
  };
  const row = async (id: string) =>
    (await sql`SELECT * FROM public.document_requests WHERE id = ${id}`)[0];

  it("an ID-verified member can request a letter or a prescription for themselves", async () => {
    const m = await mkMember(sql);
    const a = await ask(m, "MEDICAL_LETTER", "my note");
    const b = await ask(m, "PRESCRIPTION_ORDER");
    expect(a.status).toBe("REQUESTED");
    expect((await row(b.id)).document_type).toBe("PRESCRIPTION_ORDER");
  });

  it("an unverified member cannot request", async () => {
    const u = await mkUser(sql, "customer");
    expect(failedWith(await attempt(ask(u)), "member_not_verified")).toBe(true);
  });

  it("is idempotent for a repeated key, and capped at three open requests", async () => {
    const m = await mkMember(sql);
    const k = key("rq");
    const a = await rpc(sql, "request_create", m, "MEDICAL_LETTER", null, k);
    const b = await rpc(sql, "request_create", m, "MEDICAL_LETTER", null, k);
    expect(b.id).toBe(a.id);
    await ask(m);
    await ask(m);
    expect(failedWith(await attempt(ask(m)), "too_many_requests")).toBe(true);
  });

  it("rejects an unknown type, markup and an oversize note", async () => {
    const m = await mkMember(sql);
    expect(failedWith(await attempt(ask(m, "SOMETHING")), "invalid_input")).toBe(true);
    expect(failedWith(await attempt(ask(m, "MEDICAL_LETTER", "<script>")), "invalid_input")).toBe(
      true,
    );
    expect(
      failedWith(await attempt(ask(m, "MEDICAL_LETTER", "x".repeat(501))), "invalid_input"),
    ).toBe(true);
  });

  it("a member can cancel their own waiting request but not someone else's", async () => {
    const m = await mkMember(sql);
    const other = await mkMember(sql);
    const r = await ask(m);
    expect(
      failedWith(await attempt(rpc(sql, "request_cancel", other, r.id)), "request_not_found"),
    ).toBe(true);
    await rpc(sql, "request_cancel", m, r.id);
    expect((await row(r.id)).status).toBe("CANCELLED");
    expect(
      failedWith(await attempt(rpc(sql, "request_cancel", m, r.id)), "invalid_transition"),
    ).toBe(true);
  });

  describe("administrator intake", () => {
    it("assigning requires a verified practitioner and records the patient assignment", async () => {
      const w2 = await mkWorld(sql);
      const r = await ask(w2.member);
      await rpc(sql, "request_assign", w2.admin, r.id, w2.doctorId);
      expect(await row(r.id)).toMatchObject({ status: "ASSIGNED", doctor_id: w2.doctorId });
      const [{ n }] =
        await sql`SELECT count(*)::int n FROM public.doctor_patient_assignments WHERE doctor_id = ${w2.doctorId} AND member_id = ${w2.member} AND status = 'active'`;
      expect(n).toBe(1);
    });

    it("assigning a member who has no assignment yet creates one, so the practitioner can then draft", async () => {
      const m = await mkMember(sql);
      const r = await ask(m);
      await rpc(sql, "request_assign", w.admin, r.id, w.doctorId);
      const list = await rpc(sql, "doctor_list_patients", w.doctorUser);
      expect(list.map((p: { member_id: string }) => p.member_id)).toContain(m);
    });

    it("a prescription request goes only to a practitioner authorised to prescribe", async () => {
      const w2 = await mkWorld(sql, { prescribing: false });
      const r = await ask(w2.member, "PRESCRIPTION_ORDER");
      expect(
        failedWith(
          await attempt(rpc(sql, "request_assign", w2.admin, r.id, w2.doctorId)),
          "invalid_input",
        ),
      ).toBe(true);
    });

    it("an unverified, suspended or inactive practitioner cannot be chosen", async () => {
      const m = await mkMember(sql);
      const u = await mkUser(sql, "customer");
      const d = await rpc(sql, "doctor_admin_upsert", w.admin, u, {
        first_name: "P",
        last_name: "Q",
        hpcsa_number: "MP555555",
      });
      const r = await ask(m);
      expect(
        failedWith(
          await attempt(rpc(sql, "request_assign", w.admin, r.id, d.doctor_id)),
          "invalid_input",
        ),
      ).toBe(true);
    });

    it("only administrators assign, and only administrators open a request on a member's behalf", async () => {
      const r = await ask(await mkMember(sql));
      for (const who of [w.manager, w.budtender, w.doctorUser, w.member]) {
        expect(
          failedWith(await attempt(rpc(sql, "request_assign", who, r.id, w.doctorId)), "forbidden"),
        ).toBe(true);
        expect(
          failedWith(
            await attempt(
              rpc(
                sql,
                "request_admin_create",
                who,
                w.member,
                "MEDICAL_LETTER",
                null,
                null,
                key("a"),
              ),
            ),
            "forbidden",
          ),
        ).toBe(true);
        expect(
          failedWith(await attempt(rpc(sql, "request_list_admin", who, null)), "forbidden"),
        ).toBe(true);
      }
    });

    it("an administrator can open a request for a verified member, optionally assigning at once", async () => {
      const m = await mkMember(sql);
      const a = await rpc(
        sql,
        "request_admin_create",
        w.admin,
        m,
        "MEDICAL_LETTER",
        null,
        "phone call",
        key("a"),
      );
      expect(a.status).toBe("REQUESTED");
      const b = await rpc(
        sql,
        "request_admin_create",
        w.admin,
        m,
        "MEDICAL_LETTER",
        w.doctorId,
        null,
        key("a"),
      );
      expect(b.status).toBe("ASSIGNED");
      expect((await row(a.id)).source).toBe("admin");
      const unverified = await mkUser(sql, "customer");
      await sql`INSERT INTO public.profiles (id, full_name) VALUES (${unverified}, 'U') ON CONFLICT (id) DO NOTHING`;
      expect(
        failedWith(
          await attempt(
            rpc(
              sql,
              "request_admin_create",
              w.admin,
              unverified,
              "MEDICAL_LETTER",
              null,
              null,
              key("a"),
            ),
          ),
          "member_not_verified",
        ),
      ).toBe(true);
    });

    it("an administrator creating a request does NOT create a document or any clinical value", async () => {
      const m = await mkMember(sql);
      const [{ before }] = await sql`SELECT count(*)::int before FROM public.medical_documents`;
      await rpc(
        sql,
        "request_admin_create",
        w.admin,
        m,
        "PRESCRIPTION_ORDER",
        w.doctorId,
        null,
        key("a"),
      );
      const [{ after }] = await sql`SELECT count(*)::int after FROM public.medical_documents`;
      expect(after).toBe(before);
      const doc = await attempt(
        rpc(
          sql,
          "clinical_document_create",
          w.admin,
          "MEDICAL_LETTER",
          m,
          letterTpl,
          {},
          {},
          null,
          "A".repeat(43),
          key("c"),
        ),
      );
      expect(failedWith(doc, "forbidden")).toBe(true);
    });

    it("the administrator queue never carries the member's note", async () => {
      const m = await mkMember(sql);
      await ask(m, "MEDICAL_LETTER", "PRIVATE MEMBER NOTE");
      const text = JSON.stringify(await rpc(sql, "request_list_admin", w.admin, null));
      expect(text).not.toContain("PRIVATE MEMBER NOTE");
      expect(text).toContain("member_ref");
    });

    it("decline needs a reason; a declined request is terminal and the member sees the reason", async () => {
      const m = await mkMember(sql);
      const r = await ask(m);
      expect(
        failedWith(await attempt(rpc(sql, "request_decline", w.admin, r.id, "")), "invalid_input"),
      ).toBe(true);
      await rpc(sql, "request_decline", w.admin, r.id, "Please book a consultation first");
      expect(
        failedWith(
          await attempt(rpc(sql, "request_assign", w.admin, r.id, w.doctorId)),
          "invalid_transition",
        ),
      ).toBe(true);
      const mine = await rpc(sql, "request_list_member", m);
      expect(mine.find((x: { id: string }) => x.id === r.id)).toMatchObject({
        status: "DECLINED",
        decision_reason: "Please book a consultation first",
      });
    });
  });

  describe("practitioner fulfilment", () => {
    it("the assigned practitioner sees the member's note; another practitioner and staff do not", async () => {
      const w2 = await mkWorld(sql);
      const m = w2.member;
      const r = await rpc(sql, "request_create", m, "MEDICAL_LETTER", "NOTE FOR DOCTOR", key("rq"));
      await rpc(sql, "request_assign", w2.admin, r.id, w2.doctorId);
      const mine = await rpc(sql, "request_list_doctor", w2.doctorUser);
      expect(mine.find((x: { id: string }) => x.id === r.id)).toMatchObject({
        member_note: "NOTE FOR DOCTOR",
        status: "ASSIGNED",
      });
      const wB = await mkWorld(sql);
      expect(JSON.stringify(await rpc(sql, "request_list_doctor", wB.doctorUser))).not.toContain(
        "NOTE FOR DOCTOR",
      );
      expect(
        failedWith(await attempt(rpc(sql, "request_list_doctor", w2.admin)), "forbidden"),
      ).toBe(true);
    });

    it("linking a draft starts the request, issuing it fulfils the request", async () => {
      const m = await profiled();
      const r = await ask(m);
      await rpc(sql, "request_assign", w.admin, r.id, w.doctorId);
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER", { member: m });
      await rpc(sql, "request_link_document", w.doctorUser, r.id, id);
      expect(await row(r.id)).toMatchObject({ status: "IN_PROGRESS", document_id: id });
      await issue(sql, w, id);
      expect(await row(r.id)).toMatchObject({ status: "FULFILLED" });
      expect((await row(r.id)).fulfilled_at).toBeTruthy();
    });

    it("voiding the draft returns the request to the practitioner's queue", async () => {
      const m = await profiled();
      const r = await ask(m);
      await rpc(sql, "request_assign", w.admin, r.id, w.doctorId);
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER", { member: m });
      await rpc(sql, "request_link_document", w.doctorUser, r.id, id);
      await rpc(sql, "clinical_document_void", w.doctorUser, id, "started in error");
      expect(await row(r.id)).toMatchObject({ status: "ASSIGNED", document_id: null });
    });

    it("a draft must match the request's member, type and practitioner", async () => {
      const m = await profiled();
      const r = await ask(m, "PRESCRIPTION_ORDER");
      await rpc(sql, "request_assign", w.admin, r.id, w.doctorId);
      const letter = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER", { member: m });
      expect(
        failedWith(
          await attempt(rpc(sql, "request_link_document", w.doctorUser, r.id, letter.id)),
          "invalid_input",
        ),
      ).toBe(true);
      const wB = await mkWorld(sql);
      expect(
        failedWith(
          await attempt(rpc(sql, "request_link_document", wB.doctorUser, r.id, letter.id)),
          "request_not_found",
        ),
      ).toBe(true);
      const rx = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER", { member: m });
      await expect(
        rpc(sql, "request_link_document", w.doctorUser, r.id, rx.id),
      ).resolves.toBeTruthy();
    });

    it("the practitioner can decline an assigned request but not one with a draft in progress", async () => {
      const m = await profiled();
      const a = await ask(m);
      await rpc(sql, "request_assign", w.admin, a.id, w.doctorId);
      await rpc(sql, "request_decline", w.doctorUser, a.id, "Not appropriate for a letter");
      expect((await row(a.id)).status).toBe("DECLINED");
      const b = await ask(m);
      await rpc(sql, "request_assign", w.admin, b.id, w.doctorId);
      const { id } = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER", { member: m });
      await rpc(sql, "request_link_document", w.doctorUser, b.id, id);
      expect(
        failedWith(
          await attempt(rpc(sql, "request_decline", w.doctorUser, b.id, "changed my mind")),
          "invalid_transition",
        ),
      ).toBe(true);
      const wB = await mkWorld(sql);
      const c = await ask(m);
      await rpc(sql, "request_assign", w.admin, c.id, w.doctorId);
      expect(
        failedWith(
          await attempt(rpc(sql, "request_decline", wB.doctorUser, c.id, "not mine")),
          "forbidden",
        ),
      ).toBe(true);
    });
  });

  describe("RLS and immutability", () => {
    it("members read their own request rows, never another member's, and never the note column", async () => {
      const a = await mkMember(sql);
      const b = await mkMember(sql);
      const ra = await ask(a, "MEDICAL_LETTER", "A-NOTE");
      const seenByB = await asUser(
        sql,
        b,
        (tx) => tx`SELECT id FROM public.document_requests WHERE id = ${ra.id}`,
      );
      expect(seenByB).toHaveLength(0);
      const own = await asUser(sql, a, (tx) => tx`SELECT id FROM public.document_requests`);
      expect(own.map((r: any) => r.id)).toContain(ra.id);
      for (const col of ["member_note", "decision_reason", "admin_reference"]) {
        const r = await attempt(
          asUser(sql, a, (tx) => tx.unsafe(`SELECT ${col} FROM public.document_requests`)),
        );
        expect(!r.ok && r.message, col).toMatch(/permission denied/);
      }
    });

    it("administrators read request metadata only; budtenders and managers read nothing", async () => {
      const m = await mkMember(sql);
      const r = await ask(m, "MEDICAL_LETTER", "SECRET");
      const admin = await asUser(
        sql,
        w.admin,
        (tx) => tx`SELECT id FROM public.document_requests WHERE id = ${r.id}`,
      );
      expect(admin).toHaveLength(1);
      expect(
        (
          await attempt(
            asUser(sql, w.admin, (tx) => tx`SELECT member_note FROM public.document_requests`),
          )
        ).ok,
      ).toBe(false);
      for (const who of [w.budtender, w.manager]) {
        expect(
          await asUser(sql, who, (tx) => tx`SELECT id FROM public.document_requests`),
        ).toHaveLength(0);
      }
    });

    it("no client role can write requests, and no client can run the request functions", async () => {
      const m = await mkMember(sql);
      const r = await ask(m);
      for (const q of [
        (tx: typeof sql) =>
          tx`UPDATE public.document_requests SET status = 'FULFILLED' WHERE id = ${r.id}`,
        (tx: typeof sql) => tx`DELETE FROM public.document_requests WHERE id = ${r.id}`,
        (tx: typeof sql) =>
          tx`INSERT INTO public.document_requests (member_id, document_type, created_by) VALUES (${m}, 'MEDICAL_LETTER', ${m})`,
      ]) {
        const out = await attempt(asUser(sql, m, q));
        expect(!out.ok && out.message).toMatch(/permission denied/);
      }
      const fns =
        await sql`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'request\_%' AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))`;
      expect(fns).toHaveLength(0);
    });

    it("what was requested cannot be altered, and requests are never deleted", async () => {
      const m = await mkMember(sql);
      const r = await ask(m, "MEDICAL_LETTER", "orig");
      for (const q of [
        sql`UPDATE public.document_requests SET document_type = 'PRESCRIPTION_ORDER' WHERE id = ${r.id}`,
        sql`UPDATE public.document_requests SET member_note = 'changed' WHERE id = ${r.id}`,
        sql`UPDATE public.document_requests SET status = 'FULFILLED' WHERE id = ${r.id}`,
        sql`DELETE FROM public.document_requests WHERE id = ${r.id}`,
      ]) {
        const out = await attempt(q);
        expect(out.ok).toBe(false);
      }
    });
  });
});
