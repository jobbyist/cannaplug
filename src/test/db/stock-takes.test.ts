import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DB_URL,
  assertInventoryConsistent,
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

/** 5 Nov 2026: stock takes, product-level quick add/remove and delivery receiving. */
describe.skipIf(!DB_URL)("stock takes, quick adjust and deliveries (real PostgreSQL)", () => {
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
  beforeEach(async () => {
    // One open count at a time: close anything a previous test left open.
    await sql`UPDATE public.stock_takes SET status = 'cancelled', closed_by = ${manager}, closed_at = now()
              WHERE status = 'open'`;
  });

  const onHand = (p: string) => val<number>(sql`SELECT public._product_on_hand(${p})`);
  const start = (category: string | null = null) =>
    rpc(sql, "stock_take_start", manager, null, category, key("st")).then(
      (r) => r.stock_take_id as string,
    );
  const count = (take: string, p: string, n: number, actor = budtender) =>
    rpc(sql, "stock_take_record_count", actor, take, p, n, key("cnt"));
  const post = (take: string, actor = manager) =>
    rpc(sql, "stock_take_post", actor, take, key("post"));

  it("a count posts the differences: short, over and spot on, in one go", async () => {
    const a = await mkProduct(sql);
    const b = await mkProduct(sql);
    const c = await mkProduct(sql);
    await receive(sql, manager, a, 10);
    await receive(sql, manager, b, 4);
    await receive(sql, manager, c, 6);
    const t = await start();
    expect(await count(t, a, 7)).toMatchObject({ expected: 10, counted: 7, difference: -3 });
    expect(await count(t, b, 6)).toMatchObject({ difference: 2 });
    await count(t, c, 6);
    const r = await post(t);
    expect(r).toMatchObject({ lines: 3, changed: 2, units_added: 2, units_removed: 3 });
    expect([await onHand(a), await onHand(b), await onHand(c)]).toEqual([7, 6, 6]);
    const lines =
      await sql`SELECT product_id, posted_delta FROM public.stock_take_lines WHERE stock_take_id = ${t}`;
    expect(Object.fromEntries(lines.map((l) => [l["product_id"], l["posted_delta"]]))).toEqual({
      [a]: -3,
      [b]: 2,
      [c]: 0,
    });
    const moves = await sql`SELECT count(*)::int AS n FROM public.inventory_ledger
                            WHERE reference_type = 'stock_take' AND reference_id = ${t}`;
    expect(moves[0]!["n"]).toBeGreaterThanOrEqual(2);
    await assertInventoryConsistent(sql);
  });

  it("a till sale after a product was counted is not undone when the count is posted", async () => {
    const p = await mkProduct(sql, 50);
    await receive(sql, manager, p, 10);
    const t = await start();
    await count(t, p, 9); // one went missing before the count
    const { sessionId } = await mkSession(sql, manager, budtender);
    await sell(sql, budtender, sessionId, [{ product_id: p, quantity: 2 }], [cash(100)]);
    expect(await onHand(p)).toBe(8);
    await post(t);
    // 10 on the system, 9 on the shelf at count time (-1), then 2 sold: 7 left.
    expect(await onHand(p)).toBe(7);
    await assertInventoryConsistent(sql);
  });

  it("never removes stock that online orders are holding", async () => {
    const p = await mkProduct(sql, 50);
    await receive(sql, manager, p, 5);
    const member = await mkMember(sql);
    await placeOrder(sql, member, [{ product_id: p, quantity: 4 }]);
    const t = await start();
    await count(t, p, 2); // counted 2 but 4 are held for an order
    const o = await attempt(post(t));
    expect(failedWith(o, "insufficient_stock")).toBe(true);
    // Nothing moved and the count is still open to fix.
    expect(await onHand(p)).toBe(5);
    expect(await val(sql`SELECT status FROM public.stock_takes WHERE id = ${t}`)).toBe("open");
    await assertInventoryConsistent(sql);
  });

  it("removals come out of the first-expiring batch first", async () => {
    const p = await mkProduct(sql);
    const soon = new Date(Date.now() + 5 * 86400_000);
    const later = new Date(Date.now() + 60 * 86400_000);
    const late = await receive(sql, manager, p, 5, "LATE", later);
    const early = await receive(sql, manager, p, 5, "EARLY", soon);
    await rpc(sql, "stock_quick_adjust", manager, p, -3, "Damaged in store", key("qa"));
    const q = async (id: string) =>
      val<number>(sql`SELECT qty_on_hand FROM public.inventory_batches WHERE id = ${id}`);
    expect([await q(early), await q(late)]).toEqual([2, 5]);
    await rpc(sql, "stock_quick_adjust", manager, p, 4, "Found in the back", key("qa"));
    expect(await onHand(p)).toBe(11);
    await assertInventoryConsistent(sql);
  });

  it("adding stock to a product with no batch creates a dated batch", async () => {
    const p = await mkProduct(sql);
    const r = await rpc(sql, "stock_quick_adjust", manager, p, 3, "Opening count", key("qa"));
    expect(r).toMatchObject({ before: 0, after: 3 });
    const [b] = await sql`SELECT batch_code FROM public.inventory_batches WHERE product_id = ${p}`;
    expect(String(b!["batch_code"])).toMatch(/^ADJ-\d{8}$/);
  });

  it("a delivery receives many products at once, or nothing at all", async () => {
    const a = await mkProduct(sql);
    const b = await mkProduct(sql);
    const r = await rpc(
      sql,
      "stock_receive_delivery",
      manager,
      "Green Farms",
      "inv 0042",
      [
        { product_id: a, quantity: 12, unit_cost: "18.50" },
        { product_id: b, quantity: 30, expires_at: "2027-06-30" },
      ],
      key("del"),
    );
    expect(r).toMatchObject({ lines: 2, units: 42 });
    expect(String(r.batch_code)).toMatch(/^DEL-\d{8}-INV-0042$/);
    expect([await onHand(a), await onHand(b)]).toEqual([12, 30]);
    // One bad line stops the whole delivery.
    const c = await mkProduct(sql);
    const bad = await attempt(
      rpc(
        sql,
        "stock_receive_delivery",
        manager,
        null,
        null,
        [
          { product_id: c, quantity: 5 },
          { product_id: c, quantity: 1 },
        ],
        key("del"),
      ),
    );
    expect(failedWith(bad, "duplicate_product")).toBe(true);
    expect(await onHand(c)).toBe(0);
    await assertInventoryConsistent(sql);
  });

  it("budtenders can count; only managers start, post, cancel, adjust or receive", async () => {
    const p = await mkProduct(sql);
    await receive(sql, manager, p, 3);
    expect((await attempt(rpc(sql, "stock_take_start", budtender, null, null, key("s")))).ok).toBe(
      false,
    );
    const t = await start();
    expect((await attempt(count(t, p, 3, budtender))).ok).toBe(true);
    expect((await attempt(post(t, budtender))).ok).toBe(false);
    expect((await attempt(rpc(sql, "stock_take_cancel", budtender, t, key("c")))).ok).toBe(false);
    expect(
      (await attempt(rpc(sql, "stock_quick_adjust", budtender, p, -1, "Broken", key("q")))).ok,
    ).toBe(false);
    expect(
      (
        await attempt(
          rpc(
            sql,
            "stock_receive_delivery",
            budtender,
            null,
            null,
            [{ product_id: p, quantity: 1 }],
            key("d"),
          ),
        )
      ).ok,
    ).toBe(false);
    const customer = await mkUser(sql, "customer");
    expect((await attempt(count(t, p, 1, customer))).ok).toBe(false);
  });

  it("one open count at a time; a closed count cannot be counted, posted or cancelled again", async () => {
    const p = await mkProduct(sql);
    const t = await start();
    expect(failedWith(await attempt(start()), "stock_take_open")).toBe(true);
    await rpc(sql, "stock_take_cancel", manager, t, key("c"));
    expect(failedWith(await attempt(count(t, p, 1)), "stock_take_closed")).toBe(true);
    expect(failedWith(await attempt(post(t)), "stock_take_closed")).toBe(true);
    const t2 = await start();
    expect(t2).not.toBe(t);
  });

  it("a category count only takes products from that category", async () => {
    const flower = await mkProduct(sql); // mkProduct makes Flower
    const edible = await mkProduct(sql);
    await sql`UPDATE public.products SET category = 'Edibles' WHERE id = ${edible}`;
    const t = await start("Flower");
    expect((await attempt(count(t, flower, 0))).ok).toBe(true);
    expect(failedWith(await attempt(count(t, edible, 0)), "wrong_category")).toBe(true);
  });

  it("retries with the same key do nothing twice", async () => {
    const p = await mkProduct(sql);
    await receive(sql, manager, p, 10);
    const k = key("qa-retry");
    await rpc(sql, "stock_quick_adjust", manager, p, -2, "Sample given out", k);
    const again = await rpc(sql, "stock_quick_adjust", manager, p, -2, "Sample given out", k);
    expect(again).toMatchObject({ replayed: true });
    expect(await onHand(p)).toBe(8);
    const t = await start();
    await count(t, p, 5);
    const pk = key("post-retry");
    await rpc(sql, "stock_take_post", manager, t, pk);
    expect(await rpc(sql, "stock_take_post", manager, t, pk)).toMatchObject({ replayed: true });
    expect(await onHand(p)).toBe(5);
  });

  it("everything is audited", async () => {
    const p = await mkProduct(sql);
    await receive(sql, manager, p, 2);
    const t = await start();
    await count(t, p, 1);
    await post(t);
    const actions = await sql`SELECT action FROM public.audit_log
                              WHERE entity_id = ${t} ORDER BY id`;
    expect(actions.map((a) => a["action"])).toEqual([
      "stock_take_started",
      "stock_counted",
      "stock_take_posted",
    ]);
  });

  it("only the server can call the functions; staff can read counts, browsers cannot write", async () => {
    for (const role of ["anon", "authenticated"]) {
      const [g] = await sql`SELECT
        has_function_privilege(${role}, 'public.stock_take_post(uuid,uuid,text)', 'EXECUTE') AS post,
        has_function_privilege(${role}, 'public._stock_move_product(uuid,uuid,integer,text,text,uuid,text)', 'EXECUTE') AS mv,
        has_table_privilege(${role}, 'public.stock_take_lines', 'INSERT') AS ins`;
      expect(g).toEqual({ post: false, mv: false, ins: false });
    }
  });

  it("mutation check: without the manager check a budtender could post a count", async () => {
    const p = await mkProduct(sql);
    await receive(sql, manager, p, 4);
    const t = await start();
    await count(t, p, 1);
    class Undo extends Error {}
    await sql
      .begin(async (tx) => {
        const [def] =
          await tx`SELECT pg_get_functiondef('public.stock_take_post(uuid,uuid,text)'::regprocedure) AS d`;
        const broken = String(def!["d"]).replace(
          "PERFORM public._assert_staff(p_actor, 'manager');",
          "PERFORM public._assert_staff(p_actor, 'budtender');",
        );
        expect(broken).not.toBe(def!["d"]);
        await tx.unsafe(broken);
        await tx.unsafe(`SELECT public.stock_take_post('${budtender}', '${t}', '${key("mut")}')`);
        throw new Undo();
      })
      .catch((e) => {
        if (!(e instanceof Undo)) throw e;
      });
    expect((await attempt(post(t, budtender))).ok).toBe(false);
    expect(await onHand(p)).toBe(4);
  });

  it("mutation check: without the held-stock rule a count could take stock promised to an order", async () => {
    const p = await mkProduct(sql, 50);
    await receive(sql, manager, p, 5);
    const member = await mkMember(sql);
    await placeOrder(sql, member, [{ product_id: p, quantity: 4 }]);
    const t = await start();
    await count(t, p, 2);
    class Undo extends Error {}
    await sql
      .begin(async (tx) => {
        const [def] = await tx`SELECT pg_get_functiondef(
          'public._stock_move_product(uuid,uuid,integer,text,text,uuid,text)'::regprocedure) AS d`;
        const broken = String(def!["d"]).replace(
          "SELECT b.qty_on_hand - b.qty_held INTO v_avail",
          "SELECT b.qty_on_hand INTO v_avail",
        );
        expect(broken).not.toBe(def!["d"]);
        await tx.unsafe(broken);
        // The batch CHECK (held <= on hand) is the last line of defence; the posting itself no longer refuses.
        const o = await attempt(
          Promise.resolve(
            tx.unsafe(`SELECT public.stock_take_post('${manager}', '${t}', '${key("mut")}')`),
          ),
        );
        expect(failedWith(o, "insufficient_stock")).toBe(false);
        throw new Undo();
      })
      .catch((e) => {
        if (!(e instanceof Undo)) throw e;
      });
    expect(failedWith(await attempt(post(t)), "insufficient_stock")).toBe(true);
    expect(await onHand(p)).toBe(5);
  });
});
