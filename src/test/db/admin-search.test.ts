import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asUser,
  attempt,
  connect,
  failedWith,
  mkProduct,
  mkUser,
  placeOrder,
  receive,
  rpc,
  uid,
  type Sql,
} from "./helpers";

describe.skipIf(!DB_URL)("admin search (real PostgreSQL)", () => {
  let sql: Sql;
  let budtender: string;
  let manager: string;
  const tag = uid().slice(0, 8);
  beforeAll(async () => {
    sql = connect(10);
    budtender = await mkUser(sql, "budtender");
    manager = await mkUser(sql, "manager");
  });
  afterAll(async () => {
    await sql.end();
  });
  const search = (q: string, actor = budtender) => rpc(sql, "admin_search", actor, q, 6);
  const profile = (id: string, name: string, phone: string | null = null) =>
    sql`INSERT INTO public.profiles (id, full_name, phone) VALUES (${id}, ${name}, ${phone})
        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone`;

  it("finds products by name, SKU and barcode, without cost prices", async () => {
    const p = await mkProduct(sql, 120);
    await sql`UPDATE public.products SET name = ${"Zkittlez " + tag}, sku = ${"SKU-" + tag},
              barcode = ${"600" + tag.replace(/[^0-9]/g, "1").padEnd(8, "7")}, cost_rand = 44 WHERE id = ${p}`;
    await receive(sql, manager, p, 7);
    for (const q of [`zkittlez ${tag}`, `sku-${tag}`]) {
      const r = await search(q);
      expect(
        r.products.map((x: { id: string }) => x.id),
        q,
      ).toContain(p);
    }
    const hit = (await search(`SKU-${tag}`)).products[0];
    expect(hit).toMatchObject({ id: p, available: 7, is_active: true });
    expect(JSON.stringify(hit)).not.toMatch(/cost/);
  });

  it("finds orders by number and by the customer's name, email or phone; customers too, never staff", async () => {
    const member = await mkUser(sql, "customer");
    await profile(member, `Thandi ${tag}`, "+27 82 555 0199");
    const { orderId } = await placeOrder(sql, member, [
      {
        product_id: await (async () => {
          const p = await mkProduct(sql, 50);
          await receive(sql, manager, p, 5);
          return p;
        })(),
        quantity: 1,
      },
    ]);
    await sql`UPDATE public.orders SET contact_name = ${`Thandi ${tag}`}, contact_phone = '082 555 0199' WHERE id = ${orderId}`;
    const number = (await sql`SELECT order_number FROM public.orders WHERE id = ${orderId}`)[0]![
      "order_number"
    ];
    expect((await search(String(number))).orders[0].id).toBe(orderId);
    const byName = await search(`thandi ${tag}`);
    expect(byName.orders.map((o: { id: string }) => o.id)).toContain(orderId);
    expect(byName.customers.map((c: { id: string }) => c.id)).toContain(member);
    expect((await search(`customer-${member}`)).customers[0].id).toBe(member); // email
    expect((await search("082 555 0199")).customers.map((c: { id: string }) => c.id)).toContain(
      member,
    );
    await profile(budtender, `Thandi ${tag} Staff`);
    expect(
      (await search(`thandi ${tag}`)).customers.map((c: { id: string }) => c.id),
    ).not.toContain(budtender);
  });

  it("treats % and _ literally and ignores queries that are too short", async () => {
    const all = await search("%%");
    expect(all.products.length + all.orders.length + all.customers.length).toBe(0);
    expect(await search("a")).toEqual({ orders: [], customers: [], products: [], sales: [] });
  });

  it("is staff only and never callable from a browser session", async () => {
    const member = await mkUser(sql, "customer");
    expect(failedWith(await attempt(search("zkittlez", member)), "forbidden")).toBe(true);
    const browser = await attempt(
      asUser(sql, budtender, (tx) => tx`SELECT public.admin_search(${budtender}::uuid, 'zk', 6)`),
    );
    expect(browser.ok).toBe(false);
  });
});
