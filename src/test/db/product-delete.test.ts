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
  placeOrder,
  receive,
  rpc,
  sell,
  val,
  type Sql,
} from "./helpers";

/** 8 Nov 2026: delete products from /admin → Products (removed if unused, archived if they have history). */
describe.skipIf(!DB_URL)("product delete and restore (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let budtender: string;
  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
    budtender = await mkUser(sql, "budtender");
  });
  afterAll(async () => {
    await sql.end();
  });

  const del = (p: string, actor = manager, k = key("del")) =>
    rpc(sql, "product_delete", actor, p, k);
  const restore = (p: string, actor = manager) => rpc(sql, "product_restore", actor, p, key("rs"));
  const exists = (p: string) =>
    val<number>(sql`SELECT count(*)::int FROM public.products WHERE id = ${p}`);
  const state = async (p: string) => {
    const [r] = await sql`SELECT is_active, archived_at IS NOT NULL AS archived, archived_by
                          FROM public.products WHERE id = ${p}`;
    return r as { is_active: boolean; archived: boolean; archived_by: string | null };
  };

  it("a product never sold or stocked is removed for good, with its price history and wishlist rows", async () => {
    const p = await mkProduct(sql);
    const member = await mkMember(sql);
    await sql`INSERT INTO public.wishlist_items (user_id, product_id) VALUES (${member}, ${p})`;
    expect(
      await val<number>(
        sql`SELECT count(*)::int FROM public.product_price_history WHERE product_id = ${p}`,
      ),
    ).toBeGreaterThan(0);
    expect(await del(p)).toMatchObject({ mode: "deleted", product_id: p });
    expect(await exists(p)).toBe(0);
    expect(
      await val<number>(
        sql`SELECT count(*)::int FROM public.product_price_history WHERE product_id = ${p}`,
      ),
    ).toBe(0);
    expect(
      await val<number>(
        sql`SELECT count(*)::int FROM public.wishlist_items WHERE product_id = ${p}`,
      ),
    ).toBe(0);
    const [audit] = await sql`SELECT actor_user_id, metadata FROM public.audit_log
                              WHERE action = 'product_deleted' AND entity_id = ${p}`;
    expect(audit!["actor_user_id"]).toBe(manager);
  });

  it("a product with stock, a till sale or an online order is archived, never deleted", async () => {
    const stocked = await mkProduct(sql);
    await receive(sql, manager, stocked, 3);
    const sold = await mkProduct(sql, 40);
    await receive(sql, manager, sold, 5);
    const cashier = await mkUser(sql, "budtender");
    const { sessionId } = await mkSession(sql, manager, cashier);
    await sell(sql, cashier, sessionId, [{ product_id: sold, quantity: 1 }], [cash(40)]);
    const ordered = await mkProduct(sql, 30);
    await receive(sql, manager, ordered, 5);
    await placeOrder(sql, await mkMember(sql), [{ product_id: ordered, quantity: 1 }]);

    for (const p of [stocked, sold, ordered]) {
      expect(await del(p)).toMatchObject({ mode: "archived" });
      expect(await state(p)).toEqual({ is_active: false, archived: true, archived_by: manager });
    }
    const audits = await sql`SELECT count(*)::int AS n FROM public.audit_log
                             WHERE action = 'product_archived' AND entity_id IN ${sql([stocked, sold, ordered])}`;
    expect(audits[0]!["n"]).toBe(3);
  });

  it("restore brings an archived product back on; switching it on in the editor does the same", async () => {
    const p = await mkProduct(sql);
    await receive(sql, manager, p, 2);
    await del(p);
    expect(await restore(p)).toMatchObject({ product_id: p });
    expect(await state(p)).toEqual({ is_active: true, archived: false, archived_by: null });
    expect(failedWith(await attempt(restore(p)), "product_not_archived")).toBe(true);

    await del(p);
    await sql`UPDATE public.products SET is_active = true WHERE id = ${p}`;
    expect((await state(p)).archived).toBe(false);
    // An archived product can never be active at the same time.
    await sql`UPDATE public.products SET archived_at = now() WHERE id = ${p}`;
    expect(await state(p)).toMatchObject({ is_active: false, archived: true });
  });

  it("managers and admins only; retries are idempotent; unknown products are refused", async () => {
    const p = await mkProduct(sql);
    expect(failedWith(await attempt(del(p, budtender)), "forbidden")).toBe(true);
    expect(failedWith(await attempt(del(p, await mkMember(sql))), "forbidden")).toBe(true);
    expect(await exists(p)).toBe(1);
    const admin = await mkUser(sql, "admin");
    const k = key("same");
    expect(await del(p, admin, k)).toMatchObject({ mode: "deleted" });
    expect(await del(p, admin, k)).toMatchObject({ mode: "deleted", replayed: true });
    expect(failedWith(await attempt(del(p)), "product_not_found")).toBe(true);
  });

  it("price history still refuses an ordinary delete, and browsers cannot call either function", async () => {
    const p = await mkProduct(sql);
    const o = await attempt(
      Promise.resolve(sql`DELETE FROM public.product_price_history WHERE product_id = ${p}`),
    );
    expect(o.ok).toBe(false);
    for (const role of ["anon", "authenticated"]) {
      const [g] = await sql`SELECT
        has_function_privilege(${role}, 'public.product_delete(uuid,uuid,text)', 'EXECUTE') AS del,
        has_function_privilege(${role}, 'public.product_restore(uuid,uuid,text)', 'EXECUTE') AS rs,
        has_table_privilege(${role}, 'public.product_price_history', 'DELETE') AS ph`;
      expect(g).toEqual({ del: false, rs: false, ph: false });
    }
  });

  it("mutation check: without the history check a sold product's records would be deleted", async () => {
    const p = await mkProduct(sql, 40);
    await receive(sql, manager, p, 5);
    const cashier = await mkUser(sql, "budtender");
    const { sessionId } = await mkSession(sql, manager, cashier);
    await sell(sql, cashier, sessionId, [{ product_id: p, quantity: 1 }], [cash(40)]);
    class Undo extends Error {}
    await sql
      .begin(async (tx) => {
        const [def] =
          await tx`SELECT pg_get_functiondef('public.product_delete(uuid,uuid,text)'::regprocedure) AS d`;
        const broken = String(def!["d"]).replace(
          "IF public._product_has_history(p_product_id) THEN",
          "IF false THEN",
        );
        expect(broken).not.toBe(def!["d"]);
        await tx.unsafe(broken);
        // The foreign keys are the last line of defence: the delete fails instead of archiving.
        const o = await attempt(
          Promise.resolve(
            tx.unsafe(`SELECT public.product_delete('${manager}', '${p}', '${key("mut")}')`),
          ),
        );
        expect(o.ok).toBe(false);
        throw new Undo();
      })
      .catch((e) => {
        if (!(e instanceof Undo)) throw e;
      });
    expect(await del(p)).toMatchObject({ mode: "archived" });
    expect(await exists(p)).toBe(1);
  });
});
