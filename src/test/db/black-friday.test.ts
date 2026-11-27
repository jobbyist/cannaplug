import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  attempt,
  connect,
  failedWith,
  key,
  mkMember,
  mkUser,
  payOrder,
  receive,
  rpc,
  uid,
  val,
  type Sql,
} from "./helpers";

// Fri 27 Nov 2026 00:00 SAST up to Tue 1 Dec 2026 00:00 SAST.
const FROM = Date.parse("2026-11-26T22:00:00Z");
const TO = Date.parse("2026-11-30T22:00:00Z");
const nowInWindow = Date.now() >= FROM && Date.now() < TO;

describe.skipIf(!DB_URL)("Black Friday + Cyber Monday 2026 (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
  });
  afterAll(async () => void (await sql.end()));

  const product = async (opts: {
    category?: string;
    subcategory?: string | null;
    price: number;
  }) => {
    const id = uid();
    await sql`INSERT INTO public.products (id, slug, name, category, subcategory, price_rand)
              VALUES (${id}, ${`bf-${id}`}, ${`BF ${id.slice(0, 6)}`}, ${opts.category ?? "Flower"},
                      ${opts.subcategory ?? null}, ${opts.price})`;
    return id;
  };
  const row = async (id: string) =>
    (
      await sql`SELECT price_rand::float AS price, regular_price_rand::float AS regular, sale_online_only AS online,
                       sale_ends_at FROM public.products WHERE id = ${id}`
    )[0]!;
  const place = (user: string, items: unknown, total: number) =>
    rpc(
      sql,
      "checkout_place_order",
      user,
      items,
      "Test Person",
      "+27 82 000 0000",
      "collection",
      null,
      "eft",
      total,
      null,
      key("co"),
    );

  it("the window runs from Friday 00:00 SAST to the end of Monday 30 Nov", async () => {
    const at = (iso: string) =>
      val<boolean>(sql`SELECT public.bfcm_campaign_active(${iso}::timestamptz)`);
    expect(await at("2026-11-26T21:59:59Z")).toBe(false); // Thu 23:59:59 SAST
    expect(await at("2026-11-26T22:00:00Z")).toBe(true); // Fri 00:00:00 SAST
    expect(await at("2026-11-30T21:59:59Z")).toBe(true); // Mon 23:59:59 SAST
    expect(await at("2026-11-30T22:00:00Z")).toBe(false); // Tue 00:00:00 SAST
  });

  describe("online orders before the ID check", () => {
    it("a member with no ID or a pending ID can order; only a rejected ID is stopped", async () => {
      const p = await product({ price: 100 });
      await receive(sql, manager, p, 20);
      const items = [{ product_id: p, quantity: 1 }];
      const none = await mkUser(sql, "customer");
      expect(await place(none, items, 100)).toMatchObject({
        status: "awaiting_payment",
        total: 100,
      });
      const pending = await mkUser(sql, "customer");
      await sql`INSERT INTO public.customer_verification
                  (user_id, status, document_type, document_path, declared_dob, submitted_at)
                VALUES (${pending}, 'pending', 'sa_id', ${`${pending}/d.png`}, '1990-01-01', now())`;
      expect(await place(pending, items, 100)).toMatchObject({ status: "awaiting_payment" });
      const rejected = await mkUser(sql, "customer");
      await sql`INSERT INTO public.customer_verification (user_id, status) VALUES (${rejected}, 'rejected')`;
      expect(failedWith(await attempt(place(rejected, items, 100)), "verification_rejected")).toBe(
        true,
      );
    });
  });

  describe("double loyalty points", () => {
    // A R500 online pickup order, completed, whose "placed" time is set to `placedAt`.
    const earnedFor = async (placedAt: string) => {
      const member = await mkMember(sql);
      const p = await product({ price: 500 });
      await receive(sql, manager, p, 5);
      const o = await place(member, [{ product_id: p, quantity: 1 }], 500);
      await sql`UPDATE public.orders SET created_at = ${placedAt}::timestamptz WHERE id = ${o.order_id}`;
      await payOrder(sql, o.order_id);
      for (const s of ["packing", "ready", "completed"])
        await rpc(sql, "transition_order_status", o.order_id, s, manager, null);
      return Number(
        await val(
          sql`SELECT COALESCE(SUM(points), 0) FROM public.loyalty_transactions
              WHERE user_id = ${member} AND txn_type = 'earn'`,
        ),
      );
    };
    it("an online pickup order placed in the window earns twice the points", async () => {
      expect(await earnedFor("2026-11-28T10:00:00Z")).toBe(20); // R500 = 10 points, doubled
    });
    it("the same order placed outside the window earns the normal points", async () => {
      expect(await earnedFor("2026-11-20T10:00:00Z")).toBe(10);
    });
    it("the last second of Monday still doubles; Tuesday does not", async () => {
      expect(await earnedFor("2026-11-30T21:59:59Z")).toBe(20);
      expect(await earnedFor("2026-11-30T22:00:01Z")).toBe(10);
    });
  });

  it("Double Plug Back needs 5 tubes inside the window and 10 outside it", async () => {
    expect(await val<number>(sql`SELECT public.plug_back_tubes_per_reward()`)).toBe(
      nowInWindow ? 5 : 10,
    );
  });

  describe("scheduled sales", () => {
    const schedule = (
      id: string,
      price: number,
      startsInMin: number,
      endsInMin: number,
      onlineOnly = false,
    ) =>
      sql`INSERT INTO public.scheduled_sales (campaign, product_id, sale_price_rand, starts_at, ends_at, online_only)
          VALUES ('test-campaign', ${id}, ${price}, now() + ${startsInMin} * interval '1 minute',
                  now() + ${endsInMin} * interval '1 minute', ${onlineOnly})`;
    const start = () => rpc<number>(sql, "products_start_due_sales", null);
    const startedRows = (id: string) =>
      val<number>(
        sql`SELECT count(*)::int FROM public.audit_log WHERE action = 'product_sale_started' AND entity_id = ${id}`,
      );

    it("does nothing before the start time, then puts the sale on the product", async () => {
      const id = await product({ price: 100 });
      await schedule(id, 70, 60, 600, true);
      await start();
      expect(await row(id)).toMatchObject({ price: 100, regular: null, online: false });
      await sql`UPDATE public.scheduled_sales SET starts_at = now() - interval '1 minute' WHERE product_id = ${id}`;
      await start();
      expect(await row(id)).toMatchObject({ price: 70, regular: 100, online: true });
      expect((await row(id))["sale_ends_at"]).not.toBeNull();
      expect(await startedRows(id)).toBe(1);
    });
    it("starts a sale only once", async () => {
      const id = await product({ price: 100 });
      await schedule(id, 80, -1, 600);
      await start();
      await start();
      expect(await row(id)).toMatchObject({ price: 80, regular: 100 });
      expect(await startedRows(id)).toBe(1);
    });
    it("skips a sale that is not below the regular price, and one that is already over", async () => {
      const a = await product({ price: 50 });
      await schedule(a, 55, -1, 600);
      const b = await product({ price: 100 });
      await schedule(b, 60, -120, -60);
      await start();
      expect(await row(a)).toMatchObject({ price: 50, regular: null });
      expect(await row(b)).toMatchObject({ price: 100, regular: null });
      expect(
        await val(sql`SELECT skipped_reason FROM public.scheduled_sales WHERE product_id = ${a}`),
      ).toBe("not_lower_than_regular");
      expect(
        await val(sql`SELECT skipped_reason FROM public.scheduled_sales WHERE product_id = ${b}`),
      ).toBe("already_over");
    });
    it("uses the regular price of a product already on sale as the base", async () => {
      const id = await product({ price: 100 });
      await sql`UPDATE public.products SET price_rand = 90, regular_price_rand = 100 WHERE id = ${id}`;
      await schedule(id, 75, -1, 600);
      await start();
      expect(await row(id)).toMatchObject({ price: 75, regular: 100 });
    });
    it("a started sale ends by itself, and an online-only flag goes with it", async () => {
      const id = await product({ price: 100 });
      await schedule(id, 60, -1, 600, true);
      await start();
      await sql`UPDATE public.products SET sale_ends_at = now() - interval '1 second' WHERE id = ${id}`;
      await rpc(sql, "products_end_expired_sales", null);
      expect(await row(id)).toMatchObject({ price: 100, regular: null, online: false });
    });
    it("is not callable by browser roles", async () => {
      const r = await attempt(
        sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE authenticated`;
          return tx`SELECT public.products_start_due_sales(NULL)`;
        }),
      );
      expect(r.ok).toBe(false);
    });
  });

  describe("the campaign's own sales", () => {
    it("queues them by category and grade, once, and leaves the products alone until they start", async () => {
      const top = await product({ subcategory: "Top Shelf", price: 120 });
      const acc = await product({ category: "Accessories", price: 200 });
      const entry = await product({ subcategory: "Entry Indoor", price: 100 });
      const edible = await product({ category: "Edibles", price: 150 });
      const green = await product({ subcategory: "Greendoor", price: 70 });
      const other = await product({ subcategory: "Outdoor", price: 40 });
      await rpc(sql, "schedule_black_friday_2026");
      const count = () =>
        val<number>(
          sql`SELECT count(*)::int FROM public.scheduled_sales WHERE campaign = 'bfcm-2026'`,
        );
      const n = await count();
      await rpc(sql, "schedule_black_friday_2026");
      expect(await count()).toBe(n); // idempotent
      const q = async (id: string) =>
        (
          await sql`SELECT sale_price_rand::float AS price, online_only AS online, starts_at, ends_at
                    FROM public.scheduled_sales WHERE campaign = 'bfcm-2026' AND product_id = ${id}`
        )[0];
      expect(await q(top)).toMatchObject({ price: 90, online: false });
      expect(await q(acc)).toMatchObject({ price: 160, online: false });
      expect(await q(entry)).toMatchObject({ price: 70, online: true });
      expect(await q(edible)).toMatchObject({ price: 120, online: true });
      expect(await q(green)).toMatchObject({ price: 55, online: true });
      expect(await q(other)).toBeUndefined();
      const ms = (v: unknown) => new Date(v as string).getTime();
      const g = (await q(green))!;
      expect(ms(g["starts_at"])).toBe(Date.parse("2026-11-29T22:00:00Z")); // Mon 00:00 SAST
      expect(ms(g["ends_at"])).toBe(Date.parse("2026-11-30T21:59:59Z")); // Mon 23:59:59 SAST
      const t = (await q(top))!;
      expect(ms(t["starts_at"])).toBe(Date.parse("2026-11-26T22:00:00Z")); // Fri 00:00 SAST
      expect(ms(t["ends_at"])).toBe(Date.parse("2026-11-29T21:59:59Z")); // Sun 23:59:59 SAST
      if (Date.now() < FROM) {
        await rpc(sql, "products_start_due_sales", null);
        expect(await row(top)).toMatchObject({ price: 120, regular: null });
      }
    });
  });
});
