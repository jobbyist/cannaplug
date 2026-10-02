import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  asUser,
  attempt,
  connect,
  failedWith,
  key,
  mkProduct,
  mkUser,
  mkMember,
  receive,
  rpc,
  uid,
  val,
  type Sql,
} from "./helpers";

/**
 * ID verification at sign-up with manual review, against real PostgreSQL.
 * Browser behaviour is reproduced with `asUser` (role `authenticated` + JWT subject).
 */
describe.skipIf(!DB_URL)("ID verification (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;

  beforeAll(async () => {
    sql = connect(20);
    manager = await mkUser(sql, "manager");
  });
  afterAll(async () => {
    await sql.end();
  });

  const adult = "1990-05-17";
  const pathFor = (user: string, ext = "jpg") => `${user}/${uid()}.${ext}`;
  const submit = (user: string, over: Record<string, unknown> = {}) =>
    rpc(
      sql,
      "verification_submit",
      user,
      over["type"] ?? "sa_id",
      over["path"] ?? pathFor(user),
      over["dob"] ?? adult,
      over["key"] ?? key("sub"),
    );
  const review = (
    actor: string,
    user: string,
    decision: string,
    code: string | null = null,
    note: string | null = null,
    k = key("rev"),
  ) => rpc(sql, "verification_review", actor, user, decision, code, note, k);
  const row = async (user: string) =>
    (await sql`SELECT * FROM public.customer_verification WHERE user_id = ${user}`)[0];
  const customer = async () => {
    const id = await mkUser(sql, "customer");
    await sql`INSERT INTO public.profiles (id, full_name) VALUES (${id}, 'Test Member')
              ON CONFLICT DO NOTHING`;
    return id;
  };

  describe("submitting", () => {
    it("moves a new member to pending with their evidence and audits it", async () => {
      const u = await customer();
      const path = pathFor(u, "png");
      expect(await submit(u, { path })).toMatchObject({ status: "pending", attempt: 1 });
      expect(await row(u)).toMatchObject({
        status: "pending",
        document_type: "sa_id",
        document_path: path,
        attempt_count: 1,
      });
      expect(
        await val(
          sql`SELECT count(*)::int FROM public.audit_log WHERE action = 'id_verification_submitted' AND target_user_id = ${u}`,
        ),
      ).toBe(1);
    });

    it("is idempotent per key: a retry replays and does not burn an attempt", async () => {
      const u = await customer();
      const k = key("sub");
      const path = pathFor(u);
      await submit(u, { key: k, path });
      expect(await submit(u, { key: k, path })).toMatchObject({ replayed: true });
      expect((await row(u))!["attempt_count"]).toBe(1);
    });

    it("refuses under-18s, impossible dates and unknown document types", async () => {
      const u = await customer();
      const today = new Date();
      const seventeen = new Date(today.getFullYear() - 17, today.getMonth(), today.getDate());
      const eighteenToday = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      expect(failedWith(await attempt(submit(u, { dob: iso(seventeen) })), "underage")).toBe(true);
      expect(failedWith(await attempt(submit(u, { dob: "2999-01-01" })), "invalid_dob")).toBe(true);
      expect(failedWith(await attempt(submit(u, { dob: "1800-01-01" })), "invalid_dob")).toBe(true);
      expect(
        failedWith(await attempt(submit(u, { type: "library_card" })), "invalid_document_type"),
      ).toBe(true);
      // Exactly 18 today is allowed.
      expect((await attempt(submit(u, { dob: iso(eighteenToday) }))).ok).toBe(true);
    });

    it("only accepts a file in the member's own folder", async () => {
      const u = await customer();
      const other = await customer();
      for (const path of [
        pathFor(other),
        `${u}/../${other}/${uid()}.jpg`,
        `${u}/${uid()}.exe`,
        `${u}/not-a-uuid.jpg`,
        `${u}/${uid()}.jpg/extra`,
        "",
      ]) {
        expect(failedWith(await attempt(submit(u, { path })), "invalid_document_path")).toBe(true);
      }
      expect(await row(u)).toBeUndefined();
    });

    it("cannot be resubmitted while pending or after approval", async () => {
      const u = await customer();
      await submit(u);
      expect(failedWith(await attempt(submit(u)), "verification_pending")).toBe(true);
      await review(manager, u, "approve");
      expect(failedWith(await attempt(submit(u)), "already_verified")).toBe(true);
    });

    it("allows resubmission after a rejection, up to the attempt cap", async () => {
      const u = await customer();
      for (let i = 1; i <= 5; i++) {
        expect(await submit(u)).toMatchObject({ attempt: i });
        await review(manager, u, "reject", "unreadable");
      }
      expect(failedWith(await attempt(submit(u)), "too_many_attempts")).toBe(true);
      expect((await row(u))!["status"]).toBe("rejected");
    });

    it("a resubmission clears the previous decision's fields", async () => {
      const u = await customer();
      await submit(u);
      await review(manager, u, "reject", "dob_mismatch", "DOB on ID differs");
      await submit(u);
      expect(await row(u)).toMatchObject({
        status: "pending",
        rejection_code: null,
        rejection_note: null,
        reviewed_at: null,
        reviewed_by: null,
      });
    });
  });

  describe("reviewing", () => {
    it("approval verifies the member, records who/when, and syncs the profile DOB", async () => {
      const u = await customer();
      await submit(u, { dob: "1985-03-02" });
      expect(await review(manager, u, "approve")).toMatchObject({ status: "verified" });
      expect(await row(u)).toMatchObject({
        status: "verified",
        method: "manual_id_review",
        verified_by: manager,
        reviewed_by: manager,
      });
      expect((await row(u))!["verified_at"]).not.toBeNull();
      expect(
        String(await val(sql`SELECT date_of_birth FROM public.profiles WHERE id = ${u}`)),
      ).toContain("1985");
      expect(
        await val(
          sql`SELECT count(*)::int FROM public.audit_log WHERE action = 'id_verification_approved' AND actor_user_id = ${manager} AND target_user_id = ${u}`,
        ),
      ).toBe(1);
    });

    it("rejection needs a reason, and 'other' needs a note", async () => {
      const u = await customer();
      await submit(u);
      expect(
        failedWith(await attempt(review(manager, u, "reject")), "rejection_reason_required"),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(review(manager, u, "reject", "made_up")),
          "rejection_reason_required",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(review(manager, u, "reject", "other")),
          "rejection_reason_required",
        ),
      ).toBe(true);
      expect((await row(u))!["status"]).toBe("pending");
      await review(manager, u, "reject", "other", "  Photo cropped  ");
      expect(await row(u)).toMatchObject({
        status: "rejected",
        rejection_code: "other",
        rejection_note: "Photo cropped",
        verified_at: null,
        verified_by: null,
      });
    });

    it("only a pending record can be decided, and a retry with the same key replays", async () => {
      const u = await customer();
      expect(
        failedWith(await attempt(review(manager, u, "approve")), "verification_not_found"),
      ).toBe(true);
      await submit(u);
      const k = key("rev");
      await review(manager, u, "approve", null, null, k);
      expect(await review(manager, u, "approve", null, null, k)).toMatchObject({ replayed: true });
      expect(
        failedWith(await attempt(review(manager, u, "reject", "unreadable")), "not_pending"),
      ).toBe(true);
      expect(
        await val(
          sql`SELECT count(*)::int FROM public.audit_log WHERE action = 'id_verification_approved' AND target_user_id = ${u}`,
        ),
      ).toBe(1);
    });

    it("concurrent approvals decide once", async () => {
      const u = await customer();
      await submit(u);
      const m2 = await mkUser(sql, "manager");
      const results = await Promise.all([
        attempt(review(manager, u, "approve")),
        attempt(review(m2, u, "reject", "unreadable")),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.message.startsWith("not_pending"))).toHaveLength(1);
    });

    it("needs a manager: budtenders, customers and nobody are refused", async () => {
      const u = await customer();
      await submit(u);
      for (const actor of [await mkUser(sql, "budtender"), await customer(), null as never]) {
        const o = await attempt(review(actor, u, "approve"));
        expect(failedWith(o, "forbidden")).toBe(true);
      }
      expect((await row(u))!["status"]).toBe("pending");
    });

    it("nobody reviews their own ID, even a manager", async () => {
      const m = await mkUser(sql, "manager");
      await submit(m);
      expect(failedWith(await attempt(review(m, m, "approve")), "self_review_forbidden")).toBe(
        true,
      );
      expect((await row(m))!["status"]).toBe("pending");
    });

    it("approval re-checks age against the declared date at decision time", async () => {
      const u = await customer();
      await submit(u);
      const tomorrow17 = new Date();
      tomorrow17.setFullYear(tomorrow17.getFullYear() - 17);
      await sql`UPDATE public.customer_verification SET declared_dob = ${tomorrow17.toISOString().slice(0, 10)} WHERE user_id = ${u}`;
      expect(failedWith(await attempt(review(manager, u, "approve")), "underage")).toBe(true);
    });

    it("opening an ID image is audited, and refused for non-managers", async () => {
      const u = await customer();
      const path = pathFor(u);
      await submit(u, { path });
      expect(await rpc(sql, "verification_log_document_view", manager, u)).toMatchObject({
        path,
        document_type: "sa_id",
      });
      expect(
        await val(
          sql`SELECT count(*)::int FROM public.audit_log WHERE action = 'id_document_viewed' AND actor_user_id = ${manager} AND target_user_id = ${u}`,
        ),
      ).toBe(1);
      const budtender = await mkUser(sql, "budtender");
      const denied = await attempt(rpc(sql, "verification_log_document_view", budtender, u));
      expect(failedWith(denied, "forbidden")).toBe(true);
      expect(
        failedWith(
          await attempt(rpc(sql, "verification_log_document_view", manager, await customer())),
          "verification_not_found",
        ),
      ).toBe(true);
    });
  });

  describe("the order gate", () => {
    async function basket() {
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 50);
      return [{ product_id: product, quantity: 1 }];
    }
    async function addressFor(u: string) {
      const [a] = await sql`INSERT INTO public.addresses (user_id, label, line1, suburb, city)
        VALUES (${u}, 'Home', '1 Test St', 'Gardens', 'Cape Town') RETURNING id`;
      return a!["id"] as string;
    }
    const checkout = async (u: string, items: unknown[], total = 180) =>
      rpc(
        sql,
        "checkout_place_order",
        u,
        items,
        "Test Member",
        "0820000000",
        "standard",
        await addressFor(u),
        "eft",
        total,
        null,
        key("co"),
      );

    it("refuses checkout until the ID is approved, with a status-specific reason", async () => {
      const items = await basket();
      const u = await customer();
      expect(failedWith(await attempt(checkout(u, items)), "verification_required")).toBe(true);
      await submit(u);
      expect(failedWith(await attempt(checkout(u, items)), "verification_pending")).toBe(true);
      await review(manager, u, "reject", "unreadable");
      expect(failedWith(await attempt(checkout(u, items)), "verification_required")).toBe(true);
      expect(await val(sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${u}`)).toBe(0);
      await submit(u);
      await review(manager, u, "approve");
      expect(await checkout(u, items)).toMatchObject({ status: "awaiting_payment", total: 180 });
    });

    it("an expired verification blocks orders again", async () => {
      const items = await basket();
      const u = await mkMember(sql);
      await sql`UPDATE public.customer_verification SET status = 'expired' WHERE user_id = ${u}`;
      expect(failedWith(await attempt(checkout(u, items)), "verification_required")).toBe(true);
    });

    it("a refused checkout leaves stock untouched", async () => {
      const items = await basket();
      const u = await customer();
      const before = await val(sql`SELECT count(*)::int FROM public.stock_reservations`);
      await attempt(checkout(u, items));
      expect(await val(sql`SELECT count(*)::int FROM public.stock_reservations`)).toBe(before);
    });

    it("blocks a reorder for a member who is no longer verified", async () => {
      const items = await basket();
      const u = await mkMember(sql);
      const first = await checkout(u, items);
      await sql`UPDATE public.customer_verification SET status = 'rejected' WHERE user_id = ${u}`;
      const o = await attempt(rpc(sql, "create_reorder", u, first.order_id, 180, key("ro")));
      expect(failedWith(o, "verification_required")).toBe(true);
    });
  });

  describe("client access", () => {
    it("a member reads only their own row and never the document path or declared DOB", async () => {
      const a = await customer();
      const b = await customer();
      await submit(a);
      await submit(b);
      const own = await asUser(
        sql,
        a,
        (tx) => tx`SELECT status, document_type FROM public.customer_verification`,
      );
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({ status: "pending" });
      for (const col of ["document_path", "declared_dob", "reviewed_by", "verified_by"]) {
        const o = await attempt(
          asUser(sql, a, (tx) => tx.unsafe(`SELECT ${col} FROM public.customer_verification`)),
        );
        expect(o.ok, col).toBe(false);
      }
      expect(
        (await attempt(asUser(sql, a, (tx) => tx`SELECT * FROM public.customer_verification`))).ok,
      ).toBe(false);
    });

    it("no client can write verification state, including managers and the member themselves", async () => {
      const u = await customer();
      await submit(u);
      for (const actor of [u, manager]) {
        const victim = await customer();
        const upd = await attempt(
          asUser(
            sql,
            actor,
            (tx) =>
              tx`UPDATE public.customer_verification SET status = 'verified' WHERE user_id = ${u}`,
          ),
        );
        expect(upd.ok, "update").toBe(false);
        const ins = await attempt(
          asUser(
            sql,
            actor,
            (tx) =>
              tx`INSERT INTO public.customer_verification (user_id, status) VALUES (${victim}, 'verified')`,
          ),
        );
        expect(ins.ok, "insert").toBe(false);
        const del = await attempt(
          asUser(
            sql,
            actor,
            (tx) => tx`DELETE FROM public.customer_verification WHERE user_id = ${u}`,
          ),
        );
        expect(del.ok, "delete").toBe(false);
      }
      expect((await row(u))!["status"]).toBe("pending");
    });

    it("anon sees nothing", async () => {
      expect(
        (await attempt(asAnon(sql, (tx) => tx`SELECT status FROM public.customer_verification`)))
          .ok,
      ).toBe(false);
    });

    it("the functions are not callable by clients", async () => {
      const u = await customer();
      const calls: ((tx: Sql) => PromiseLike<unknown>)[] = [
        (tx) =>
          tx`SELECT public.verification_submit(${u}, 'sa_id', ${pathFor(u)}, '1990-01-01', 'abcdefgh1')`,
        (tx) =>
          tx`SELECT public.verification_review(${manager}, ${u}, 'approve', NULL, NULL, 'abcdefgh1')`,
        (tx) => tx`SELECT public.verification_log_document_view(${manager}, ${u})`,
        (tx) => tx`SELECT public._require_verified_member(${u})`,
      ];
      for (const call of calls) {
        expect((await attempt(asUser(sql, manager, async (tx) => call(tx)))).ok).toBe(false);
        expect((await attempt(asAnon(sql, async (tx) => call(tx)))).ok).toBe(false);
      }
    });
  });

  describe("schema invariants", () => {
    it("a pending row without evidence, or a verified row without an approver, cannot exist", async () => {
      const u = await customer();
      const bare = await attempt(
        Promise.resolve(
          sql`INSERT INTO public.customer_verification (user_id, status) VALUES (${u}, 'pending')`,
        ),
      );
      expect(bare.ok).toBe(false);
      const noApprover = await attempt(
        Promise.resolve(
          sql`INSERT INTO public.customer_verification (user_id, status) VALUES (${u}, 'verified')`,
        ),
      );
      expect(noApprover.ok).toBe(false);
    });

    it("the storage bucket (when storage exists) is private", async () => {
      const exists = await val(sql`SELECT to_regclass('storage.buckets') IS NOT NULL`);
      if (!exists) return;
      const [b] =
        await sql`SELECT public, file_size_limit FROM storage.buckets WHERE id = 'id-documents'`;
      expect(b).toMatchObject({ public: false, file_size_limit: 5242880 });
    });
  });
});
