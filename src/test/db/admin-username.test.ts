import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asUser,
  attempt,
  connect,
  failedWith,
  key,
  mkUser,
  rpc,
  uid,
  val,
  type Sql,
} from "./helpers";

/** Managers and admins change a member's username; sign-up works with or without one — real PostgreSQL. */
describe.skipIf(!DB_URL)(
  "admin username tool and optional sign-up username (real PostgreSQL)",
  () => {
    let sql: Sql;
    let manager: string;
    let admin: string;
    let budtender: string;
    beforeAll(async () => {
      sql = connect(10);
      manager = await mkUser(sql, "manager");
      admin = await mkUser(sql, "admin");
      budtender = await mkUser(sql, "budtender");
    });
    afterAll(async () => {
      await sql.end();
    });

    const tag = () => `n${uid().replace(/-/g, "").slice(0, 10)}`;
    const change = (actor: string, member: string, name: string, reason = "Member asked for it") =>
      rpc(sql, "admin_set_username", actor, member, name, reason, key("au"));
    const nameOf = async (id: string) =>
      (await val(sql`SELECT username FROM public.profiles WHERE id = ${id}`)) as string | null;
    const signUp = async (meta: Record<string, string>) => {
      const id = uid();
      await sql`INSERT INTO auth.users (id, email, raw_user_meta_data)
              VALUES (${id}, ${`su-${id.slice(0, 8)}@test.local`}, ${sql.json(meta)})`;
      return id;
    };

    it("a manager and an admin can change a member's username; it is audited with the reason", async () => {
      const m = await mkUser(sql, "customer");
      await rpc(sql, "member_set_username", m, tag(), key("own"));
      const before = await nameOf(m);
      const a = tag();
      expect(await change(manager, m, a.toUpperCase(), "Typo in their name")).toMatchObject({
        username: a,
        previous: before,
      });
      expect(await nameOf(m)).toBe(a);
      const b = tag();
      await change(admin, m, b);
      expect(await nameOf(m)).toBe(b);
      const audit = await sql`SELECT actor_user_id, metadata FROM public.audit_log
                            WHERE entity_id = ${m} AND action = 'admin_username_changed' ORDER BY created_at`;
      expect(audit).toHaveLength(2);
      expect(audit[0]!["actor_user_id"]).toBe(manager);
      expect(audit[0]!["metadata"]).toMatchObject({
        previous: before,
        username: a,
        reason: "Typo in their name",
      });
    });

    it("it also sets a name for a member who has none, and the result is final for the member", async () => {
      const m = await mkUser(sql, "customer");
      expect(await nameOf(m)).toBeNull();
      const a = tag();
      await change(manager, m, a);
      expect(await nameOf(m)).toBe(a);
      expect(
        failedWith(
          await attempt(rpc(sql, "member_set_username", m, tag(), key("own"))),
          "username_already_set",
        ),
      ).toBe(true);
    });

    it("a budtender, a customer and a browser cannot use it", async () => {
      const m = await mkUser(sql, "customer");
      expect(failedWith(await attempt(change(budtender, m, tag())), "forbidden")).toBe(true);
      expect(failedWith(await attempt(change(m, m, tag())), "forbidden")).toBe(true);
      const r = await attempt(
        asUser(
          sql,
          manager,
          async (tx) =>
            tx`SELECT public.admin_set_username(${manager}, ${m}, ${tag()}, 'x y z', ${key("b")})`,
        ),
      );
      expect(r.ok).toBe(false);
      expect(await nameOf(m)).toBeNull();
    });

    it("refuses staff targets, missing reasons, taken, reserved and badly formed names", async () => {
      const m = await mkUser(sql, "customer");
      const staff = await mkUser(sql, "budtender");
      expect(failedWith(await attempt(change(manager, staff, tag())), "forbidden")).toBe(true);
      expect(failedWith(await attempt(change(manager, m, tag(), " ")), "reason_required")).toBe(
        true,
      );
      expect(
        failedWith(await attempt(change(manager, m, tag(), "x".repeat(201))), "reason_required"),
      ).toBe(true);
      const other = await mkUser(sql, "customer");
      const taken = tag();
      await change(manager, other, taken);
      expect(failedWith(await attempt(change(manager, m, taken)), "username_taken")).toBe(true);
      expect(failedWith(await attempt(change(manager, m, "Admin")), "username_reserved")).toBe(
        true,
      );
      expect(failedWith(await attempt(change(manager, m, "no")), "username_invalid")).toBe(true);
      expect(
        failedWith(await attempt(change(manager, m, taken, "Same name")), "username_taken"),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(rpc(sql, "admin_set_username", manager, uid(), tag(), "Reason", key("nf"))),
          "member_not_found",
        ),
      ).toBe(true);
      expect(await nameOf(m)).toBeNull();
      // changing to the name they already have is refused
      expect(failedWith(await attempt(change(manager, other, taken)), "username_unchanged")).toBe(
        true,
      );
    });

    it("the same request twice changes the name once (idempotent)", async () => {
      const m = await mkUser(sql, "customer");
      const k = key("idem");
      const a = tag();
      await rpc(sql, "admin_set_username", manager, m, a, "Asked", k);
      expect(await rpc(sql, "admin_set_username", manager, m, a, "Asked", k)).toMatchObject({
        replayed: true,
      });
      expect(
        await val(
          sql`SELECT count(*)::int FROM public.audit_log WHERE entity_id = ${m} AND action = 'admin_username_changed'`,
        ),
      ).toBe(1);
    });

    it("the Customers page returns each member's username and searches by it", async () => {
      const m = await mkUser(sql, "customer");
      const name = tag();
      await change(manager, m, name);
      const page = await rpc(sql, "admin_customers_page", manager, name, 25, 0);
      expect(page.total).toBe(1);
      expect(page.rows[0]).toMatchObject({ id: m, username: name });
    });

    it("sign-up works with a username, without one, and a member can set one afterwards", async () => {
      const withName = tag();
      const a = await signUp({ full_name: "Has Name", username: withName });
      expect(await nameOf(a)).toBe(withName);
      const b = await signUp({ full_name: "No Name" });
      expect(await nameOf(b)).toBeNull();
      const later = tag();
      await rpc(sql, "member_set_username", b, later, key("later"));
      expect(await nameOf(b)).toBe(later);
      expect(await rpc(sql, "member_rewards_summary", b)).toMatchObject({
        username: later,
        can_change: false,
      });
    });

    it("mutation check: without the staff guard a staff member's username could be changed by a manager", async () => {
      const staff = await mkUser(sql, "budtender");
      const rolledBack = new Error("rollback");
      const out = await sql
        .begin(async (tx) => {
          const [fn] =
            await tx`SELECT pg_get_functiondef('public.admin_set_username(uuid,uuid,text,text,text)'::regprocedure) AS def`;
          const def = String(fn!["def"]);
          const broken = def.replace("IF public._is_staff(p_user_id) THEN", "IF false THEN");
          expect(broken).not.toBe(def);
          await tx.unsafe(broken);
          await rpc(
            tx as unknown as Sql,
            "admin_set_username",
            manager,
            staff,
            tag(),
            "Mutation",
            key("mut"),
          );
          throw rolledBack;
        })
        .catch((e) => e);
      expect(out).toBe(rolledBack);
      expect(failedWith(await attempt(change(manager, staff, tag())), "forbidden")).toBe(true);
    });
  },
);
