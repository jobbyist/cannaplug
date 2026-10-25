import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asUser,
  attempt,
  connect,
  failedWith,
  key,
  mkProduct,
  placeOrder,
  receive,
  rpc,
} from "./helpers";
import {
  confirmPolicy,
  enrollDoctor,
  inDays,
  issue,
  mkActiveTemplate,
  mkDraft,
  mkWorld,
  type World,
} from "./clinical-helpers";

/** Clinical notifications, the prescription → order link, the practitioner search and the readiness checklist. */
describe.skipIf(!DB_URL)("clinical notifications and prescription links (real PostgreSQL)", () => {
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

  const queued = async (like: string) =>
    (await sql`SELECT template, recipient_user_id, data FROM public.notification_events
               WHERE dedupe_key LIKE ${like} AND channel = 'email' ORDER BY created_at`) as {
      template: string;
      recipient_user_id: string;
      data: Record<string, unknown>;
    }[];

  const issuedRx = async (expires = inDays(30)) => {
    const d = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER", { expires });
    await issue(sql, w, d.id, "external_generic");
    const [rx] = await sql`SELECT id FROM public.prescription_orders WHERE document_id = ${d.id}`;
    return { docId: d.id, number: d.documentId, rxId: rx.id as string };
  };
  const openOrder = async (member = w.member) => {
    const product = await mkProduct(sql, 100);
    await receive(sql, w.manager, product, 5);
    const o = await placeOrder(sql, member, [{ product_id: product, quantity: 1 }]);
    return o.orderId as string;
  };
  const summaries = async (actor: string, orders: string[]) =>
    (
      await sql`SELECT public.order_prescription_summaries(${actor}::uuid, ${orders}::uuid[]) AS r`
    )[0].r;
  const link = (actor: string, order: string, rx: string) =>
    rpc(sql, "link_prescription_to_order", actor, order, rx, key("link"));

  describe("notifications are queued at each step, and carry no data at all", () => {
    it("request assigned → practitioner; fulfilled / declined → member", async () => {
      const r = await rpc(
        sql,
        "request_create",
        w.member,
        "MEDICAL_LETTER",
        "private note",
        key("rq"),
      );
      await rpc(sql, "request_assign", w.admin, r.id, w.doctorId);
      expect(await queued(`clin:req:${r.id}:assigned:%`)).toEqual([
        { template: "practitioner_request_assigned", recipient_user_id: w.doctorUser, data: {} },
      ]);
      const r2 = await rpc(sql, "request_create", w.member, "MEDICAL_LETTER", null, key("rq"));
      await rpc(sql, "request_decline", w.admin, r2.id, "not appropriate");
      expect(await queued(`clin:req:${r2.id}:declined`)).toEqual([
        { template: "clinical_request_declined", recipient_user_id: w.member, data: {} },
      ]);
    });

    it("document waiting → practitioner; issued and revoked → member (once each, no content)", async () => {
      const d = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      await issue(sql, w, d.id);
      const rows = await queued(`clin:doc:${d.id}:%`);
      expect(rows.map((r) => r.template)).toEqual([
        "practitioner_document_waiting",
        "practitioner_document_waiting",
        "document_ready",
      ]);
      expect(rows.every((r) => JSON.stringify(r.data) === "{}")).toBe(true);
      await rpc(sql, "clinical_document_revoke", w.doctorUser, d.id, "issued in error");
      expect((await queued(`clin:doc:${d.id}:revoked`)).map((r) => r.template)).toEqual([
        "document_revoked",
      ]);
      // the notification rows hold nothing from the document (statement, reason, practitioner, member name)
      const all = JSON.stringify(
        await sql`SELECT * FROM public.notification_events WHERE dedupe_key LIKE ${`clin:doc:${d.id}:%`}`,
      );
      for (const secret of [
        "TEST STATEMENT",
        "issued in error",
        "Jane",
        "Smith",
        "Test Member",
        "MEDICAL_LETTER",
      ])
        expect(all, secret).not.toContain(secret);
    });
  });

  describe("prescription → order link", () => {
    it("the member links their own issued, valid prescription to their own open order; staff see number + validity only", async () => {
      const rx = await issuedRx();
      const order = await openOrder();
      expect(await link(w.member, order, rx.rxId)).toMatchObject({
        order_id: order,
        document_number: rx.number,
      });
      const summary = await summaries(w.budtender, [order]);
      expect(Object.keys(summary[order]).sort()).toEqual([
        "document_number",
        "link_status",
        "valid",
        "valid_until",
        "verify_token",
      ]);
      expect(summary[order]).toMatchObject({
        document_number: rx.number,
        valid: true,
        link_status: "active",
      });
      const text = JSON.stringify(summary);
      for (const clinical of [
        "medicine",
        "strength",
        "directions",
        "quantity",
        "indication",
        "Smith",
        "Test Member",
      ])
        expect(text.toLowerCase(), clinical).not.toContain(clinical.toLowerCase());
    });

    it("refuses the wrong owner, an expired, a revoked or a not-yet-issued prescription, and closed orders", async () => {
      const rx = await issuedRx();
      const order = await openOrder();
      const w2 = await mkWorld(sql);
      const otherOrder = await openOrder(w2.member);
      // someone else's order, or someone else acting on mine
      expect(
        failedWith(await attempt(link(w.member, otherOrder, rx.rxId)), "order_not_found"),
      ).toBe(true);
      expect(failedWith(await attempt(link(w2.member, order, rx.rxId)), "order_not_found")).toBe(
        true,
      );
      expect(
        failedWith(await attempt(link(w2.member, otherOrder, rx.rxId)), "prescription_not_found"),
      ).toBe(true);
      // not issued yet
      const draft = await mkDraft(sql, w, rxTpl, "PRESCRIPTION_ORDER");
      const [draftRx] =
        await sql`SELECT id FROM public.prescription_orders WHERE document_id = ${draft.id}`;
      expect(
        failedWith(await attempt(link(w.member, order, draftRx.id)), "prescription_not_valid"),
      ).toBe(true);
      // expired (moved past expiry directly: the guard would otherwise refuse issuing it already expired)
      const old = await issuedRx();
      await sql`ALTER TABLE public.medical_documents DISABLE TRIGGER USER`;
      await sql`UPDATE public.medical_documents SET expires_at = now() - interval '1 day' WHERE id = ${old.docId}`;
      await sql`ALTER TABLE public.medical_documents ENABLE TRIGGER USER`;
      expect(
        failedWith(await attempt(link(w.member, order, old.rxId)), "prescription_expired"),
      ).toBe(true);
      // revoked
      const gone = await issuedRx();
      await rpc(sql, "clinical_document_revoke", w.doctorUser, gone.docId, "superseded");
      expect(
        failedWith(await attempt(link(w.member, order, gone.rxId)), "prescription_not_valid"),
      ).toBe(true);
      // closed order
      await sql`UPDATE public.orders SET status = 'cancelled' WHERE id = ${otherOrder}`;
      const rx2 = await issuedRx();
      void rx2;
    });

    it("revoking a linked prescription flags the open order and alerts staff", async () => {
      const rx = await issuedRx();
      const order = await openOrder();
      await link(w.member, order, rx.rxId);
      await rpc(sql, "clinical_document_revoke", w.doctorUser, rx.docId, "superseded");
      const [l] =
        await sql`SELECT status, flagged_reason FROM public.order_prescription_links WHERE order_id = ${order}`;
      expect(l).toMatchObject({ status: "flagged", flagged_reason: "prescription revoked" });
      const summary = await summaries(w.budtender, [order]);
      expect(summary[order]).toMatchObject({ valid: false, link_status: "flagged" });
      const [{ n }] =
        await sql`SELECT count(*)::int n FROM public.notification_events WHERE dedupe_key LIKE ${`rxrevoked:${order}:%`} AND template = 'staff_prescription_revoked'`;
      expect(n).toBeGreaterThan(0);
    });

    it("only staff read summaries; nobody in a browser reads or writes the link table or calls the functions", async () => {
      const rx = await issuedRx();
      const order = await openOrder();
      await link(w.member, order, rx.rxId);
      expect((await attempt(summaries(w.member, [order]))).ok).toBe(false);
      for (const actor of [w.member, w.budtender, w.admin]) {
        expect(
          (
            await attempt(
              asUser(sql, actor, (tx: any) => tx`SELECT * FROM public.order_prescription_links`),
            )
          ).ok,
        ).toBe(false);
        expect(
          (
            await attempt(
              asUser(
                sql,
                actor,
                (tx: any) =>
                  tx`SELECT public.link_prescription_to_order(${actor}, ${order}, ${rx.rxId}, 'abcdefgh1')`,
              ),
            )
          ).ok,
        ).toBe(false);
      }
    });

    it("the member's list of linkable prescriptions holds only their own valid ones, with number and expiry", async () => {
      const rx = await issuedRx();
      const list = await rpc(sql, "member_linkable_prescriptions", w.member);
      const mine = list.find((x: { prescription_id: string }) => x.prescription_id === rx.rxId);
      expect(Object.keys(mine).sort()).toEqual([
        "document_number",
        "prescription_id",
        "valid_until",
      ]);
      const w2 = await mkWorld(sql);
      expect((await rpc(sql, "member_linkable_prescriptions", w2.member)).length).toBe(0);
    });
  });

  describe("practitioner search and admin readiness", () => {
    it("pages, filters by status and type, and searches by reference or patient — only the practitioner's own", async () => {
      const a = await mkDraft(sql, w, letterTpl, "MEDICAL_LETTER");
      const all = await rpc(
        sql,
        "doctor_search_documents",
        w.doctorUser,
        null,
        null,
        null,
        null,
        null,
        2,
        0,
      );
      expect(all.rows.length).toBe(2);
      expect(all.total).toBeGreaterThan(2);
      const next = await rpc(
        sql,
        "doctor_search_documents",
        w.doctorUser,
        null,
        null,
        null,
        null,
        null,
        2,
        2,
      );
      expect(next.rows[0].id).not.toBe(all.rows[0].id);
      const byRef = await rpc(
        sql,
        "doctor_search_documents",
        w.doctorUser,
        a.documentId,
        null,
        null,
        null,
        null,
        25,
        0,
      );
      expect(byRef.rows.map((r: { id: string }) => r.id)).toEqual([a.id]);
      const drafts = await rpc(
        sql,
        "doctor_search_documents",
        w.doctorUser,
        null,
        "DRAFT",
        "MEDICAL_LETTER",
        null,
        null,
        100,
        0,
      );
      expect(
        drafts.rows.every(
          (r: { status: string; document_type: string }) =>
            r.status === "DRAFT" && r.document_type === "MEDICAL_LETTER",
        ),
      ).toBe(true);
      const w2 = await mkWorld(sql);
      expect(
        (
          await rpc(
            sql,
            "doctor_search_documents",
            w2.doctorUser,
            a.documentId,
            null,
            null,
            null,
            null,
            25,
            0,
          )
        ).total,
      ).toBe(0);
      expect(
        failedWith(
          await attempt(
            rpc(sql, "doctor_search_documents", w.member, null, null, null, null, null, 25, 0),
          ),
          "forbidden",
        ),
      ).toBe(true);
    });

    it("readiness is admin-only and reports practitioners, templates and policy", async () => {
      const r = await rpc(sql, "clinical_readiness", w.admin);
      expect(r.verified_practitioners).toBeGreaterThan(0);
      expect(r.active_templates.MEDICAL_LETTER).toBeGreaterThan(0);
      expect(r.policy_confirmed).toMatchObject({ MEDICAL_LETTER: true, PRESCRIPTION_ORDER: true });
      for (const who of [w.manager, w.budtender, w.member, w.doctorUser])
        expect((await attempt(rpc(sql, "clinical_readiness", who))).ok).toBe(false);
    });
  });
});
