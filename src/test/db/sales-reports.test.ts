import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  attempt,
  card,
  cash,
  connect,
  key,
  mkMember,
  mkProduct,
  mkSession,
  mkUser,
  payOrder,
  placeOrder,
  receive,
  rpc,
  sell,
  val,
  type Sql,
} from "./helpers";

/**
 * Sales reports: POS and online sales for South African days, a daily email to managers and admins, and no
 * customer data anywhere in the report. Other test files write sales at the same time, so this file moves its
 * own rows onto one quiet historic day (triggers off for that fixture step only) and reports on that day.
 */
describe.skipIf(!DB_URL)("sales reports (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;
  let customer: string;
  // A quiet historic day, different on every run, so reruns against the same database stay exact.
  const DAY = new Date(Date.UTC(1990, 0, 1) + Math.floor(Math.random() * 3600) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  let report: any;
  const RECENT = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
    cashier = await mkUser(sql, "budtender");
    customer = await mkUser(sql, "customer");
    await sql`UPDATE public.profiles SET full_name = 'Aidan Till' WHERE id = ${cashier}`;
    const { sessionId } = await mkSession(sql, manager, cashier);

    const flower = await mkProduct(sql, 100);
    const edible = await mkProduct(sql, 50);
    await sql`UPDATE public.products SET category = 'Edibles', name = 'Report Gummies' WHERE id = ${edible}`;
    await sql`UPDATE public.products SET name = 'Report Haze' WHERE id = ${flower}`;
    await receive(sql, manager, flower, 50);
    await receive(sql, manager, edible, 50);

    // Till: R200 cash, R150 card, a R100 sale voided, and R50 refunded from the card sale.
    const s1 = await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: flower, quantity: 2 }],
      [cash(200)],
    );
    const s2 = await sell(
      sql,
      cashier,
      sessionId,
      [
        { product_id: flower, quantity: 1 },
        { product_id: edible, quantity: 1 },
      ],
      [card(150, key("CARD"))],
    );
    const s3 = await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: flower, quantity: 1 }],
      [cash(100)],
    );
    await rpc(sql, "pos_void_sale", manager, s3.sale_id, "rang up twice", key("void"));
    const [edibleLine] =
      await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${s2.sale_id} AND product_id = ${edible}`;
    await rpc(
      sql,
      "pos_refund_sale",
      manager,
      s2.sale_id,
      sessionId,
      [{ sale_item_id: edibleLine!["id"], quantity: 1 }],
      [{ method: "card", amount: "50" }],
      "customer returned",
      true,
      key("rf"),
    );

    // Online: one paid order (2 x R50 + delivery), one left unpaid.
    const member = await mkMember(sql);
    const paid = await placeOrder(sql, member, [{ product_id: edible, quantity: 2 }]);
    await payOrder(sql, paid.orderId);
    const unpaid = await placeOrder(sql, member, [{ product_id: flower, quantity: 1 }]);

    // Move only this file's rows to DAY 10:30 SAST.
    const at = `${DAY} 10:30:00+02`;
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE public.pos_sales SET created_at = ${at} WHERE id IN ${tx([s1.sale_id, s2.sale_id, s3.sale_id])}`;
      await tx`UPDATE public.pos_refunds SET created_at = ${at} WHERE sale_id = ${s2.sale_id}`;
      await tx`UPDATE public.orders SET created_at = ${at} WHERE id IN ${tx([paid.orderId, unpaid.orderId])}`;
    });
    report = await rpc(sql, "sales_report", cashier, DAY, DAY);
    (globalThis as any).__paidTotal = paid.total;
    (globalThis as any).__unpaidTotal = unpaid.total;
  });
  afterAll(async () => {
    await sql.end();
  });

  it("adds up the till: gross without voids, refunds, net and payment methods", () => {
    expect(report.pos).toMatchObject({
      count: 2,
      gross: 350,
      refunds: 50,
      net: 300,
      refund_count: 1,
      voided_count: 1,
      voided_total: 100,
    });
    expect(report.pos_tenders).toEqual({ cash: 200, card: 150 });
    expect(report.cashiers).toEqual([{ name: "Aidan Till", count: 2, total: 350 }]);
  });

  it("counts paid online orders, and unpaid ones apart", () => {
    const paid = (globalThis as any).__paidTotal as number;
    expect(Number(report.online.count)).toBe(1);
    expect(Number(report.online.total)).toBe(paid);
    expect(Number(report.online.awaiting_count)).toBe(1);
    expect(Number(report.online.awaiting_total)).toBe((globalThis as any).__unpaidTotal);
    expect(Number(report.total)).toBe(300 + paid);
    expect(report.transactions).toBe(3);
  });

  it("splits by day, hour (SAST), product and category; refunded items are taken off", () => {
    expect(report.daily).toHaveLength(1);
    expect(Number(report.daily[0].pos)).toBe(300);
    const ten = report.hourly.find((h: any) => h.hour === 10);
    expect(Number(ten.pos)).toBe(350);
    expect(Number(ten.count)).toBe(3);
    const haze = report.products.find((p: any) => p.name === "Report Haze");
    const gummies = report.products.find((p: any) => p.name === "Report Gummies");
    expect(haze).toMatchObject({ qty: 3, revenue: 300, pos: 300, online: 0 });
    expect(gummies).toMatchObject({ qty: 2, revenue: 100, pos: 0, online: 100 }); // the till one was refunded
    expect(report.categories.map((c: any) => c.category).sort()).toEqual(["Edibles", "Flower"]);
  });

  it("lists recent transactions by receipt / order number with no customer details", () => {
    expect(report.recent).toHaveLength(5);
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/0820000000|Test|@test\.local/); // contact name, phone and emails stay out
  });

  it("only staff can read it, and the range is limited", async () => {
    expect((await attempt(rpc(sql, "sales_report", customer, DAY, DAY))).ok).toBe(false);
    expect((await attempt(rpc(sql, "sales_report", cashier, "2026-01-02", "2026-01-01"))).ok).toBe(
      false,
    );
    expect((await attempt(rpc(sql, "sales_report", cashier, "2020-01-01", "2026-01-01"))).ok).toBe(
      false,
    );
  });

  it("emails one day's report to managers and admins once a day; a manager can send it now", async () => {
    const staffEmails = Number(
      await val(sql`SELECT count(DISTINCT u.id) FROM auth.users u JOIN public.user_roles r ON r.user_id = u.id
                    WHERE r.role IN ('manager', 'admin') AND u.email IS NOT NULL`),
    );
    const n = await rpc(sql, "sales_daily_report_enqueue", DAY);
    expect(n).toBe(staffEmails);
    expect(await rpc(sql, "sales_daily_report_enqueue", DAY)).toBe(0); // once per day
    const ev = (
      await sql`SELECT data, recipient_user_id FROM public.notification_events
                WHERE template = 'staff_daily_sales' AND dedupe_key LIKE ${`daily_sales:${DAY}:%`} LIMIT 1`
    )[0]!;
    expect(ev["data"].pos.net).toBe(300);
    expect(ev["data"].products.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(ev["data"])).not.toMatch(/recent|0820000000/);
    // Budtenders do not get the email and cannot send it.
    expect(
      Number(
        await val(sql`SELECT count(*) FROM public.notification_events
                           WHERE template = 'staff_daily_sales' AND recipient_user_id = ${cashier}`),
      ),
    ).toBe(0);
    expect((await attempt(rpc(sql, "sales_report_email", cashier, RECENT, key("em")))).ok).toBe(
      false,
    );
    const k = key("em");
    const sent = await rpc(sql, "sales_report_email", manager, RECENT, k);
    expect(sent.recipients).toBe(staffEmails);
    expect((await rpc(sql, "sales_report_email", manager, RECENT, k)).replayed).toBe(true);
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.audit_log WHERE action = 'sales_report_emailed' AND actor_user_id = ${manager}`,
        ),
      ),
    ).toBe(1);
  });
});
