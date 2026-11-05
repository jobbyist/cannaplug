import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_URL, attempt, connect, key, mkUser, rpc, type Sql } from "./helpers";

/** 5 Nov 2026: branded reset emails sent by the app; the database decides whether one may go out. */
describe.skipIf(!DB_URL)("password_reset_begin / finish (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => {
    sql = connect(5);
  });
  afterAll(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    await sql`DELETE FROM public.password_reset_requests`;
    await sql`UPDATE public.email_budget_settings SET daily_limit = 100`;
  });

  const begin = (email: string, ip: string | null = "iphash01", actor: string | null = null) =>
    rpc(sql, "password_reset_begin", email, ip, actor, key("pw"));

  it("allows a request, keeps only a hash of the address and audits it", async () => {
    const r = await begin("Someone@Example.com");
    expect(r).toMatchObject({ allowed: true });
    const rows = await sql`SELECT * FROM public.password_reset_requests`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/someone@example\.com/i);
    const [a] = await sql`SELECT metadata FROM public.audit_log
                          WHERE action = 'password_reset_requested' AND entity_id = ${r.request_id}`;
    expect(a!["metadata"]).toEqual({ by_staff: false });
  });

  it("3 an hour per address, whatever the capitalisation", async () => {
    for (const e of ["a@b.co", "A@B.CO", " a@b.co "]) expect((await begin(e)).allowed).toBe(true);
    expect(await begin("a@b.co", "other-ip")).toMatchObject({
      allowed: false,
      reason: "email_limit",
    });
  });

  it("10 an hour per connection for self-service, but not for staff", async () => {
    for (let i = 0; i < 10; i++) expect((await begin(`u${i}@b.co`)).allowed).toBe(true);
    expect(await begin("u10@b.co")).toMatchObject({ allowed: false, reason: "ip_limit" });
    const manager = await mkUser(sql, "manager");
    expect((await begin("u11@b.co", "iphash01", manager)).allowed).toBe(true);
  });

  it("stops when Resend's daily allowance is used, and counts resets in the budget", async () => {
    await sql`UPDATE public.email_budget_settings SET daily_limit = 2`;
    const before = await rpc<number>(sql, "_emails_sent_24h");
    await sql`UPDATE public.email_budget_settings SET daily_limit = ${before + 1}`;
    const r = await begin("x@b.co");
    expect(r.allowed).toBe(true);
    expect(await rpc<number>(sql, "_emails_sent_24h")).toBe(before + 1);
    expect(await begin("y@b.co")).toMatchObject({ allowed: false, reason: "daily_limit" });
    // An address with no account is not an email sent: it frees its place in the budget.
    await rpc(sql, "password_reset_finish", r.request_id, "no_account");
    expect(await rpc<number>(sql, "_emails_sent_24h")).toBe(before);
  });

  it("staff requests need a manager; a budtender or customer is refused", async () => {
    const bud = await mkUser(sql, "budtender");
    const cust = await mkUser(sql, "customer");
    for (const actor of [bud, cust]) {
      const o = await attempt(begin("m@b.co", null, actor));
      expect(o.ok).toBe(false);
    }
    const manager = await mkUser(sql, "manager");
    const r = await begin("m@b.co", null, manager);
    expect(r.allowed).toBe(true);
    const [row] = await sql`SELECT requested_by, ip_hash FROM public.password_reset_requests
                            WHERE id = ${r.request_id}`;
    expect(row).toEqual({ requested_by: manager, ip_hash: null });
  });

  it("finishes once only, with a known status", async () => {
    const r = await begin("f@b.co");
    await rpc(sql, "password_reset_finish", r.request_id, "sent");
    await rpc(sql, "password_reset_finish", r.request_id, "failed");
    const [row] =
      await sql`SELECT status FROM public.password_reset_requests WHERE id = ${r.request_id}`;
    expect(row!["status"]).toBe("sent");
    expect((await attempt(rpc(sql, "password_reset_finish", r.request_id, "bogus"))).ok).toBe(
      false,
    );
  });

  it("a retry with the same key is answered from the first call", async () => {
    const k = key("pw-retry");
    const a = await rpc(sql, "password_reset_begin", "r@b.co", "iphash-retry", null, k);
    const b = await rpc(sql, "password_reset_begin", "r@b.co", "iphash-retry", null, k);
    expect(b).toMatchObject({ allowed: true, request_id: a.request_id, replayed: true });
    expect(await sql`SELECT 1 FROM public.password_reset_requests`).toHaveLength(1);
  });

  it("only the server can call it or read the table", async () => {
    for (const role of ["anon", "authenticated"]) {
      const [g] = await sql`SELECT
        has_function_privilege(${role}, 'public.password_reset_begin(text,text,uuid,text)', 'EXECUTE') AS f,
        has_table_privilege(${role}, 'public.password_reset_requests', 'SELECT') AS t`;
      expect(g).toEqual({ f: false, t: false });
    }
  });

  it("mutation check: without the per-address limit one address could be flooded with emails", async () => {
    class Undo extends Error {}
    await sql
      .begin(async (tx) => {
        const [def] = await tx`SELECT pg_get_functiondef(
          'public.password_reset_begin(text,text,uuid,text)'::regprocedure) AS d`;
        const broken = String(def!["d"]).replace(">= c_per_email THEN", ">= 1000000 THEN");
        expect(broken).not.toBe(def!["d"]);
        await tx.unsafe(broken);
        for (let i = 0; i < 4; i++)
          await tx.unsafe(
            `SELECT public.password_reset_begin('flood@b.co', 'iphash-${i}', NULL, '${key("mut")}')`,
          );
        const [c] = await tx`SELECT count(*)::int AS n FROM public.password_reset_requests`;
        expect(c!["n"]).toBe(4); // the attack works once the rule is gone
        throw new Undo();
      })
      .catch((e) => {
        if (!(e instanceof Undo)) throw e;
      });
    for (let i = 0; i < 3; i++) await begin("flood@b.co", `iphash-${i}`);
    expect(await begin("flood@b.co", "iphash-9")).toMatchObject({ allowed: false });
  });

  it("mutation check: without the manager check a budtender could send staff reset emails", async () => {
    const bud = await mkUser(sql, "budtender");
    class Undo extends Error {}
    await sql
      .begin(async (tx) => {
        const [def] = await tx`SELECT pg_get_functiondef(
          'public.password_reset_begin(text,text,uuid,text)'::regprocedure) AS d`;
        const broken = String(def!["d"]).replace(
          "PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);",
          "NULL;",
        );
        expect(broken).not.toBe(def!["d"]);
        await tx.unsafe(broken);
        await tx.unsafe(
          `SELECT public.password_reset_begin('v@b.co', NULL, '${bud}', '${key("mut")}')`,
        );
        throw new Undo();
      })
      .catch((e) => {
        if (!(e instanceof Undo)) throw e;
      });
    expect((await attempt(begin("v@b.co", null, bud))).ok).toBe(false);
  });
});
