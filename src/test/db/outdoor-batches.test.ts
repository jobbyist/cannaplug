import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  assertInventoryConsistent,
  attempt,
  cash,
  connect,
  failedWith,
  key,
  mkMember,
  mkSession,
  mkUser,
  receive,
  rpc,
  sell,
  uid,
  type Sql,
} from "./helpers";

/** Outdoor flower is sold by weight at R24/g and only in 5 g batches (real PostgreSQL). */
describe.skipIf(!DB_URL)("Outdoor flower is sold in 5 g batches (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;
  let outdoor: string;
  let greenhouse: string;
  let bag: string;

  const mkFlower = async (name: string, subcategory: string | null, byWeight = true, step = 1) => {
    const id = uid();
    await sql`INSERT INTO public.products (id, slug, name, category, subcategory, price_rand, unit, sold_by_weight, weight_step_g)
              VALUES (${id}, ${`f-${id}`}, ${name}, 'Flower', ${subcategory}, 24, ${byWeight ? "g" : "5g"}, ${byWeight}, ${step})`;
    return id;
  };

  beforeAll(async () => {
    sql = connect(10);
    [manager, cashier] = await Promise.all([mkUser(sql, "manager"), mkUser(sql, "budtender")]);
    outdoor = await mkFlower(`Test Grape ${uid().slice(0, 4)} (Outdoor)`, "Outdoor");
    greenhouse = await mkFlower(`Test Haze ${uid().slice(0, 4)} (Greenhouse)`, "Greenhouse");
    bag = await mkFlower(`Test Bag ${uid().slice(0, 4)} (Outdoor)`, "Outdoor", false);
    for (const p of [outdoor, greenhouse, bag]) await receive(sql, manager, p, 500);
  });
  afterAll(async () => {
    await assertInventoryConsistent(sql);
    await sql.end();
  });

  const stepOf = async (id: string) =>
    Number(
      (await sql`SELECT weight_step_g FROM public.products WHERE id = ${id}`)[0]!["weight_step_g"],
    );

  it("a weighed Outdoor product is kept at a 5 g step by the database, however it is created or edited", async () => {
    expect(await stepOf(outdoor)).toBe(5);
    expect(await stepOf(greenhouse)).toBe(1);
    expect(await stepOf(bag)).toBe(1); // sold as one bag, not by weight: never a 5 g step
    await sql`UPDATE public.products SET weight_step_g = 1 WHERE id = ${outdoor}`;
    expect(await stepOf(outdoor)).toBe(5);
    // A product named (Outdoor) with no subcategory is Outdoor too.
    const named = await mkFlower(`Named ${uid().slice(0, 4)} (Outdoor)`, null);
    expect(await stepOf(named)).toBe(5);
    // Moving a product out of Outdoor leaves its step alone (an admin can then set it).
    await sql`UPDATE public.products SET subcategory = 'Greenhouse', name = ${`Moved ${uid().slice(0, 4)} (Greenhouse)`} WHERE id = ${named}`;
    await sql`UPDATE public.products SET weight_step_g = 1 WHERE id = ${named}`;
    expect(await stepOf(named)).toBe(1);
  });

  it("the weight step can be 0.5, 1 or 5 and nothing else", async () => {
    for (const ok of [0.5, 1, 5]) {
      await sql`UPDATE public.products SET weight_step_g = ${ok} WHERE id = ${greenhouse}`;
    }
    for (const bad of [0.25, 2, 3, 10]) {
      const r = await attempt(
        sql`UPDATE public.products SET weight_step_g = ${bad} WHERE id = ${greenhouse}`,
      );
      expect(r.ok).toBe(false);
    }
    await sql`UPDATE public.products SET weight_step_g = 1 WHERE id = ${greenhouse}`;
  });

  it("the till sells Outdoor only in multiples of 5 g, at R24 a gram", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier);
    for (const q of [1, 4, 6, 12]) {
      const r = await attempt(
        sell(sql, cashier, sessionId, [{ product_id: outdoor, quantity: q }], [cash(q * 24)]),
      );
      expect(failedWith(r, "invalid_batch_size")).toBe(true);
    }
    const five = await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: outdoor, quantity: 5 }],
      [cash(120)],
    );
    expect(Number(five.total)).toBe(120);
    const fifteen = await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: outdoor, quantity: 15 }],
      [cash(360)],
    );
    expect(Number(fifteen.total)).toBe(360);
    // Two lines of the same product are added together first: 2 + 3 = 5 is a full batch.
    const split = await sell(
      sql,
      cashier,
      sessionId,
      [
        { product_id: outdoor, quantity: 2 },
        { product_id: outdoor, quantity: 3 },
      ],
      [cash(120)],
    );
    expect(Number(split.total)).toBe(120);
  });

  it("other products are not affected: Greenhouse by the gram, and a bag sold as one unit", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier);
    const g = await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: greenhouse, quantity: 1 }],
      [cash(24)],
    );
    expect(Number(g.total)).toBe(24);
    const b = await sell(sql, cashier, sessionId, [{ product_id: bag, quantity: 3 }], [cash(72)]);
    expect(Number(b.total)).toBe(72);
  });

  it("a refused sale leaves no stock taken and no sale behind", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier);
    const before =
      await sql`SELECT count(*)::int AS n FROM public.pos_sales WHERE session_id = ${sessionId}`;
    await attempt(
      sell(sql, cashier, sessionId, [{ product_id: outdoor, quantity: 7 }], [cash(168)]),
    );
    const after =
      await sql`SELECT count(*)::int AS n FROM public.pos_sales WHERE session_id = ${sessionId}`;
    expect(after[0]!["n"]).toBe(before[0]!["n"]);
    await assertInventoryConsistent(sql);
  });

  it("online checkout refuses a part-batch and accepts a full one", async () => {
    const member = await mkMember(sql);
    const address = (
      await rpc(
        sql,
        "member_save_address",
        member,
        null,
        { label: "Home", line1: "1 Test Street", city: "Pretoria" },
        false,
      )
    ).id as string;
    const place = (qty: number, total: number) =>
      rpc(
        sql,
        "checkout_place_order",
        member,
        [{ product_id: outdoor, quantity: qty }],
        "Test Member",
        "+27 82 000 0000",
        "standard",
        address,
        "eft",
        total,
        null,
        key("co"),
      );
    const bad = await attempt(place(3, 72 + 80));
    expect(failedWith(bad, "invalid_batch_size")).toBe(true);
    const ok = await attempt(place(5, 120 + 80));
    expect(ok.ok, ok.ok ? "" : (ok as { message: string }).message).toBe(true);
  });

  it("product CSV import accepts a 5 g step (an exported file imports again)", async () => {
    const sku = `CSV-${uid().slice(0, 8)}`;
    const run = (step: number, k: string) =>
      attempt(
        rpc(
          sql,
          "bulk_upsert_products",
          manager,
          [
            {
              sku,
              slug: sku.toLowerCase(),
              name: `Csv ${sku} (Outdoor)`,
              category: "Flower",
              price: "24.00",
              sold_by_weight: true,
              weight_step_g: step,
            },
          ],
          createHash("sha256").update(uid()).digest("hex"),
          k,
        ),
      );
    const r = await run(5, key("csv"));
    expect(r.ok, r.ok ? "" : (r as { message: string }).message).toBe(true);
    const row = await sql`SELECT weight_step_g FROM public.products WHERE sku = ${sku}`;
    expect(Number(row[0]!["weight_step_g"])).toBe(5);
    const bad = await run(2, key("csv"));
    expect(bad.ok).toBe(false);
  });

  it("browser roles cannot run the step functions", async () => {
    for (const fn of [
      "_sale_step(uuid)",
      "_enforce_sale_step()",
      "_is_outdoor_flower(text,text,text)",
    ]) {
      const [row] = await sql.unsafe(
        `SELECT has_function_privilege('authenticated', 'public.${fn}', 'EXECUTE') AS a,
                has_function_privilege('anon', 'public.${fn}', 'EXECUTE') AS b`,
      );
      expect(row).toMatchObject({ a: false, b: false });
    }
  });

  it("MUTATION CHECK: without the trigger a part-batch goes through, so the trigger is what enforces the rule", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier);
    await sql`ALTER TABLE public.pos_sale_items DISABLE TRIGGER pos_sale_items_sale_step`;
    try {
      const r = await attempt(
        sell(sql, cashier, sessionId, [{ product_id: outdoor, quantity: 3 }], [cash(72)]),
      );
      expect(r.ok).toBe(true);
    } finally {
      await sql`ALTER TABLE public.pos_sale_items ENABLE TRIGGER pos_sale_items_sale_step`;
    }
    const again = await attempt(
      sell(sql, cashier, sessionId, [{ product_id: outdoor, quantity: 3 }], [cash(72)]),
    );
    expect(failedWith(again, "invalid_batch_size")).toBe(true);
  });
});
