import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  asUser,
  assertInventoryConsistent,
  attempt,
  connect,
  key,
  mkMember,
  mkSession,
  mkUser,
  receive,
  rpc,
  stockOf,
  uid,
  val,
  type Sql,
} from "./helpers";

describe.skipIf(!DB_URL)("Plug Back (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;
  let sessionId: string;
  let greenhouse: string;
  let indoor: string;

  const named = async (name: string, category = "Pre-rolls") => {
    const id = uid();
    await sql`INSERT INTO public.products (id, slug, name, category, price_rand)
              VALUES (${id}, ${`pb-${id}`}, ${name}, ${category}, 60)`;
    return id;
  };
  const tubes = (c: string, n: number) =>
    rpc(sql, "plug_back_record_return", cashier, c, n, null, key("pb"));
  const redeem = (c: string, p = greenhouse, k = key("pbr"), actor = cashier) =>
    rpc(sql, "plug_back_redeem", actor, sessionId, c, p, k);
  const balance = async (c: string) => (await rpc(sql, "plug_back_summary", cashier, c)).tubes;

  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
    cashier = await mkUser(sql, "budtender");
    ({ sessionId } = await mkSession(sql, manager, cashier));
    greenhouse = await named(`Plug Tube Pre-roll (Greenhouse)`);
    indoor = await named(`Plug Tube Pre-roll (Entry Indoor)`);
    await receive(sql, manager, greenhouse, 50);
    await receive(sql, manager, indoor, 50);
  });
  afterAll(async () => void (await sql.end()));

  it("counts tubes and shows progress towards the next free pre-roll", async () => {
    const m = await mkMember(sql);
    expect((await tubes(m, 4)).tubes).toBe(4);
    const s = await rpc(sql, "plug_back_summary", cashier, m);
    expect(s).toMatchObject({
      tubes: 4,
      tubes_per_reward: 10,
      rewards_available: 0,
      tubes_to_next: 6,
    });
    expect(s.products.map((p: any) => p.id)).toContain(greenhouse);
    expect(s.products.map((p: any) => p.id)).not.toContain(indoor); // only Greenhouse pre-rolls
    await tubes(m, 6);
    expect(await rpc(sql, "plug_back_summary", cashier, m)).toMatchObject({
      tubes: 10,
      rewards_available: 1,
      tubes_to_next: 0,
    });
  });

  it("gives 1 free Greenhouse pre-roll for 10 tubes as an R0 sale and takes 10 tubes off", async () => {
    const m = await mkMember(sql);
    await tubes(m, 23);
    const before = (await stockOf(sql, greenhouse)).on_hand;
    const r = await redeem(m);
    expect(r).toMatchObject({ total: 0, tubes_spent: 10, tubes: 13 });
    expect(r.receipt_number).toMatch(/^POS-/);
    expect((await stockOf(sql, greenhouse)).on_hand).toBe(before - 1);
    expect(await balance(m)).toBe(13);
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.audit_log WHERE entity_id = ${r.sale_id} AND action = 'plug_back_redeemed'`,
      ),
    ).toBe(1);
    expect(Number(await val(sql`SELECT total FROM public.pos_sales WHERE id = ${r.sale_id}`))).toBe(
      0,
    );
    await assertInventoryConsistent(sql);
  });

  it("refuses with fewer than 10 tubes, another grade, or a non-pre-roll, and changes nothing", async () => {
    const m = await mkMember(sql);
    await tubes(m, 9);
    const before = (await stockOf(sql, greenhouse)).on_hand;
    const short = await attempt(redeem(m));
    expect(!short.ok && short.message).toMatch(/^insufficient_tubes/);
    await tubes(m, 1);
    const flower = await named("Plug Flower (Greenhouse)", "Flower");
    for (const p of [indoor, flower]) {
      const r = await attempt(redeem(m, p));
      expect(!r.ok && r.message, String(p)).toMatch(/^reward_not_eligible/);
    }
    expect(await balance(m)).toBe(10);
    expect((await stockOf(sql, greenhouse)).on_hand).toBe(before);
  });

  it("a failed sale (out of stock) does not spend the tubes", async () => {
    const m = await mkMember(sql);
    await tubes(m, 10);
    const empty = await named("Plug Empty Pre-roll (Greenhouse)");
    const r = await attempt(redeem(m, empty));
    expect(r.ok).toBe(false);
    expect(await balance(m)).toBe(10);
  });

  it("replays the same key without giving a second pre-roll", async () => {
    const m = await mkMember(sql);
    await tubes(m, 20);
    const k = key("pbr");
    const a = await redeem(m, greenhouse, k);
    const b = await redeem(m, greenhouse, k);
    expect(b.replayed).toBe(true);
    expect(b.sale_id).toBe(a.sale_id);
    expect(await balance(m)).toBe(10);
  });

  it("two tills cannot spend the same tubes", async () => {
    const m = await mkMember(sql);
    await tubes(m, 10);
    const results = await Promise.all([attempt(redeem(m)), attempt(redeem(m))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await balance(m)).toBe(0);
  });

  it("voiding the free sale gives the tubes and the stock back, once", async () => {
    const m = await mkMember(sql);
    await tubes(m, 10);
    const before = (await stockOf(sql, greenhouse)).on_hand;
    const r = await redeem(m);
    expect(await balance(m)).toBe(0);
    await rpc(sql, "pos_void_sale", manager, r.sale_id, "Wrong customer", key("void"));
    expect(await balance(m)).toBe(10);
    expect((await stockOf(sql, greenhouse)).on_hand).toBe(before);
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.plug_back_ledger WHERE source_type = 'redeem_void' AND source_id = ${r.sale_id}`,
      ),
    ).toBe(1);
    // the rewards_given count ignores a voided reward
    expect((await rpc(sql, "plug_back_summary", cashier, m)).rewards_given).toBe(0);
  });

  it("a normal sale that is voided does not create tubes", async () => {
    const m = await mkMember(sql);
    const r = await rpc(
      sql,
      "pos_complete_sale",
      cashier,
      sessionId,
      [{ product_id: greenhouse, quantity: 1 }],
      [{ method: "cash", amount: "60" }],
      m,
      key("sale"),
      null,
      null,
    );
    await rpc(sql, "pos_void_sale", manager, r.sale_id, "Test void", key("void"));
    expect(await balance(m)).toBe(0);
  });

  it("validates tube counts and the customer", async () => {
    const m = await mkMember(sql);
    for (const n of [0, -3, 101, null]) {
      const r = await attempt(rpc(sql, "plug_back_record_return", cashier, m, n, null, key("pb")));
      expect(r.ok, String(n)).toBe(false);
    }
    const ghost = await attempt(
      rpc(sql, "plug_back_record_return", cashier, uid(), 1, null, key("pb")),
    );
    expect(!ghost.ok && ghost.message).toMatch(/^customer_not_found/);
    expect(await balance(m)).toBe(0);
  });

  it("is staff-only and not callable from a browser", async () => {
    const m = await mkMember(sql);
    await tubes(m, 10);
    const plain = await mkUser(sql, "customer");
    for (const fn of [
      () => rpc(sql, "plug_back_record_return", plain, m, 5, null, key("pb")),
      () => rpc(sql, "plug_back_summary", plain, m),
      () => redeem(m, greenhouse, key("pbr"), plain),
    ]) {
      const r = await attempt(fn());
      expect(!r.ok && r.message).toMatch(/forbidden/);
    }
    for (const run of [
      (tx: Sql) =>
        tx`SELECT public.plug_back_record_return(${cashier}::uuid, ${m}::uuid, 5, null, ${key("pb")})`,
      (tx: Sql) =>
        tx`SELECT public.plug_back_redeem(${cashier}::uuid, ${sessionId}::uuid, ${m}::uuid, ${greenhouse}::uuid, ${key("pbr")})`,
      (tx: Sql) => tx`SELECT public.plug_back_summary(${cashier}::uuid, ${m}::uuid)`,
    ]) {
      expect((await attempt(asUser(sql, cashier, run))).ok).toBe(false);
      expect((await attempt(asAnon(sql, run))).ok).toBe(false);
    }
    // the table itself: no browser reads or writes
    expect(
      (await attempt(asUser(sql, m, (tx) => tx`SELECT * FROM public.plug_back_ledger`))).ok,
    ).toBe(false);
    expect(
      (
        await attempt(
          asUser(
            sql,
            m,
            (tx) =>
              tx`INSERT INTO public.plug_back_ledger (user_id, tubes, source_type, source_id) VALUES (${m}, 50, 'return', ${uid()})`,
          ),
        )
      ).ok,
    ).toBe(false);
    expect(await balance(m)).toBe(10);
  });

  it("the ledger is append-only", async () => {
    const m = await mkMember(sql);
    await tubes(m, 3);
    const u = await attempt(
      Promise.resolve(sql`UPDATE public.plug_back_ledger SET tubes = 99 WHERE user_id = ${m}`),
    );
    const d = await attempt(
      Promise.resolve(sql`DELETE FROM public.plug_back_ledger WHERE user_id = ${m}`),
    );
    expect(u.ok).toBe(false);
    expect(d.ok).toBe(false);
    expect(await balance(m)).toBe(3);
  });

  it("mutation check: with the tube check removed, a 9-tube member WOULD get a pre-roll (so the check is what protects)", async () => {
    const m = await mkMember(sql);
    await tubes(m, 9);
    const def = await val<string>(
      sql`SELECT pg_get_functiondef('public.plug_back_redeem(uuid,uuid,uuid,uuid,text)'::regprocedure)`,
    );
    const broken = def.replace("< v_per THEN", "< 0 THEN");
    expect(broken).not.toBe(def);
    class Undo extends Error {}
    let sold = false;
    await sql
      .begin(async (tx) => {
        await tx.unsafe(broken);
        const r = await attempt(
          rpc(
            tx as unknown as Sql,
            "plug_back_redeem",
            cashier,
            sessionId,
            m,
            greenhouse,
            key("pbr"),
          ),
        );
        sold = r.ok;
        throw new Undo("roll the mutation back");
      })
      .catch((e) => {
        if (!(e instanceof Undo)) throw e;
      });
    expect(sold).toBe(true);
    expect(await balance(m)).toBe(9); // rolled back: the real function is untouched
  });
});
