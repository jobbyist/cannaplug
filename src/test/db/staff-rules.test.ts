import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  attempt,
  cash,
  connect,
  failedWith,
  key,
  mkMember,
  mkProduct,
  mkSession,
  mkUser,
  receive,
  rpc,
  sell,
  uid,
  type Role,
  type Sql,
} from "./helpers";

/** Staff skip the online ID check, and the till limits who may be attached as a staff customer — real PostgreSQL. */
describe.skipIf(!DB_URL)("staff ID exemption and till attach rules (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;

  beforeAll(async () => {
    sql = connect(20);
    manager = await mkUser(sql, "manager");
  });
  afterAll(async () => {
    await sql.end();
  });

  const product = async (price = 100) => {
    const id = await mkProduct(sql, price);
    await receive(sql, manager, id, 100);
    return id;
  };

  describe("online ID check", () => {
    const order = async (user: string) => {
      const p = await product();
      return rpc(
        sql,
        "checkout_place_order",
        user,
        [{ product_id: p, quantity: 1 }],
        "Test Person",
        "+27 82 000 0000",
        "collection",
        null,
        "eft",
        null, // the total is not known here: the gate must refuse (or pass) before the price check
        null,
        key("co"),
      );
    };
    it.each(["budtender", "manager", "admin"] as const)(
      "a %s with no ID on file is not stopped by the ID check",
      async (role) => {
        const staff = await mkUser(sql, role);
        // Past the gate, the next thing the function asks for is the expected total.
        const r = await attempt(order(staff));
        expect(failedWith(r, "expected_total_required")).toBe(true);
      },
    );
    it("a staff member with no ID can place a real online order at the staff rate", async () => {
      const staff = await mkUser(sql, "budtender");
      const p = await product(100);
      const o = await rpc(
        sql,
        "checkout_place_order",
        staff,
        [{ product_id: p, quantity: 1 }],
        "Test Person",
        "+27 82 000 0000",
        "collection",
        null,
        "eft",
        80,
        null,
        key("co"),
      );
      expect(o).toMatchObject({ total: 80, staff_purchase: true });
    });
    it("a member with no ID, a pending ID, or none verified is still stopped", async () => {
      const plain = await mkUser(sql, "customer");
      expect(failedWith(await attempt(order(plain)), "verification_required")).toBe(true);
      const pending = await mkUser(sql, "customer");
      const doc = `${pending}/doc.png`;
      await sql`INSERT INTO public.customer_verification
                  (user_id, status, document_type, document_path, declared_dob, submitted_at)
                VALUES (${pending}, 'pending', 'sa_id', ${doc}, '1990-01-01', now())`;
      expect(failedWith(await attempt(order(pending)), "verification_pending")).toBe(true);
    });
  });

  describe("attaching a staff member to a till sale", () => {
    let sessionFor: Record<string, string>;
    const people: Record<string, string> = {};
    beforeAll(async () => {
      const cashiers = {
        budtender: await mkUser(sql, "budtender"),
        manager,
        admin: await mkUser(sql, "admin"),
      };
      sessionFor = {};
      for (const [role, id] of Object.entries(cashiers)) {
        sessionFor[role] = (await mkSession(sql, manager, id)).sessionId;
        people[role] = id;
      }
      people["otherBudtender"] = await mkUser(sql, "budtender");
      people["otherManager"] = await mkUser(sql, "manager");
      people["otherAdmin"] = await mkUser(sql, "admin");
      people["member"] = await mkMember(sql);
      // A budtender who has also been promoted: their highest role counts.
      const promoted = await mkUser(sql, "budtender");
      await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${promoted}, 'manager'::public.app_role)`;
      people["budtenderAndManager"] = promoted;
    });

    const trySell = async (actor: "budtender" | "manager" | "admin", customer: string) => {
      const p = await product(100);
      const staff = customer !== people["member"];
      return attempt(
        sell(
          sql,
          people[actor]!,
          sessionFor[actor]!,
          [{ product_id: p, quantity: 1 }],
          [cash(staff ? 80 : 100)],
          {
            customer,
          },
        ),
      );
    };

    it("managers and admins can attach any staff member, themselves included", async () => {
      for (const actor of ["manager", "admin"] as const)
        for (const target of [
          "otherBudtender",
          "otherManager",
          "otherAdmin",
          actor,
          "budtenderAndManager",
        ])
          expect((await trySell(actor, people[target]!)).ok, `${actor} -> ${target}`).toBe(true);
    });

    it("a budtender can attach another budtender", async () => {
      const r = await trySell("budtender", people["otherBudtender"]!);
      expect(r.ok).toBe(true);
    });

    it("a budtender cannot attach themselves, a manager, an admin, or someone who is also a manager", async () => {
      for (const target of [
        "budtender",
        "otherManager",
        "otherAdmin",
        "manager",
        "admin",
        "budtenderAndManager",
      ]) {
        const r = await trySell("budtender", people[target]!);
        expect(failedWith(r, "staff_attach_not_allowed"), `budtender -> ${target}`).toBe(true);
      }
    });

    it("anyone can still attach a member (not staff), and a refused attach records nothing", async () => {
      expect((await trySell("budtender", people["member"]!)).ok).toBe(true);
      const before = Number(
        (
          await sql`SELECT count(*) FROM public.pos_sales WHERE customer_id = ${people["budtender"]!}`
        )[0]!["count"],
      );
      await trySell("budtender", people["budtender"]!);
      const after = Number(
        (
          await sql`SELECT count(*) FROM public.pos_sales WHERE customer_id = ${people["budtender"]!}`
        )[0]!["count"],
      );
      expect(after).toBe(before);
    });

    it("the till search says which staff can be attached, and why not", async () => {
      const tag = `zz${uid().slice(0, 6)}`;
      const names: Record<string, string> = {
        self: people["budtender"]!,
        peer: people["otherBudtender"]!,
        boss: people["otherManager"]!,
        member: people["member"]!,
      };
      for (const [k, id] of Object.entries(names))
        await sql`INSERT INTO public.profiles (id, full_name) VALUES (${id}, ${`${tag} ${k}`})
                  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name`;
      type Hit = {
        id: string;
        can_attach: boolean;
        blocked_reason: string | null;
        is_staff: boolean;
      };
      const asBudtender = await rpc<Hit[]>(
        sql,
        "pos_customer_search",
        people["budtender"],
        tag,
        10,
      );
      const by = (rows: Hit[], id: string) => rows.find((r) => r.id === id)!;
      expect(by(asBudtender, names["peer"]!)).toMatchObject({
        can_attach: true,
        blocked_reason: null,
      });
      expect(by(asBudtender, names["member"]!)).toMatchObject({
        can_attach: true,
        is_staff: false,
      });
      expect(by(asBudtender, names["self"]!)).toMatchObject({ can_attach: false });
      expect(by(asBudtender, names["self"]!).blocked_reason).toMatch(/yourself/);
      expect(by(asBudtender, names["boss"]!)).toMatchObject({ can_attach: false });
      expect(by(asBudtender, names["boss"]!).blocked_reason).toMatch(/manager or admin/);
      const asManager = await rpc<Hit[]>(sql, "pos_customer_search", people["manager"], tag, 10);
      for (const id of Object.values(names)) expect(by(asManager, id).can_attach).toBe(true);
    });

    it("mutation check: without the rule a budtender could give themselves the staff rate", async () => {
      const rolledBack = new Error("rollback");
      const p = await product(100);
      const out = await sql
        .begin(async (tx) => {
          await tx.unsafe(
            "CREATE OR REPLACE FUNCTION public._pos_can_attach_staff(p_actor uuid, p_customer uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$",
          );
          const s = await sell(
            tx as unknown as Sql,
            people["budtender"]!,
            sessionFor["budtender"]!,
            [{ product_id: p, quantity: 1 }],
            [cash(80)],
            {
              customer: people["budtender"]!,
            },
          );
          expect(s.staff_purchase).toBe(true);
          throw rolledBack;
        })
        .catch((e) => e);
      expect(out).toBe(rolledBack);
      // and with the real rule restored it is refused again
      expect((await trySell("budtender", people["budtender"]!)).ok).toBe(false);
    });
  });

  it("the roles used by these tests exist", () => {
    const roles: Role[] = ["budtender", "manager", "admin", "customer"];
    expect(roles).toHaveLength(4);
  });
});
