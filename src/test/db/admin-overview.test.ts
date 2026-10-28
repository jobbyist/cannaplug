import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  assertInventoryConsistent,
  attempt,
  card,
  cash,
  connect,
  failedWith,
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
  uid,
  type Sql,
} from "./helpers";

describe.skipIf(!DB_URL)(
  "admin overview, customers, alerts and archiving (real PostgreSQL)",
  () => {
    let sql: Sql;
    let admin: string;
    let manager: string;
    let cashier: string;
    const tag = uid().slice(0, 8);

    beforeAll(async () => {
      sql = connect(10);
      [admin, manager, cashier] = await Promise.all([
        mkUser(sql, "admin"),
        mkUser(sql, "manager"),
        mkUser(sql, "budtender"),
      ]);
    });
    afterAll(async () => {
      await sql.end();
    });

    const window = (from: string, to: string) =>
      sql`SELECT public._revenue_window(${from}::timestamptz, ${to}::timestamptz) AS r`.then(
        (x) => x[0]!["r"] as { pos: string | number; online: string | number },
      );
    const order = (userId: string, status: string, total: number, at: string) =>
      sql`INSERT INTO public.orders (user_id, status, total_rand, created_at, payment_method)
        VALUES (${userId}, ${status}, ${total}, ${at}, 'card')`;

    describe("revenue", () => {
      it("counts paid online orders only, by South African day (the day starts at 22:00 UTC)", async () => {
        const u = await mkUser(sql, "customer");
        // SAST day 2019-05-10 = [2019-05-09T22:00Z, 2019-05-10T22:00Z)
        await order(u, "confirmed", 100, "2019-05-09T22:00:00Z");
        await order(u, "completed", 50.5, "2019-05-10T21:59:59Z");
        await order(u, "awaiting_payment", 999, "2019-05-10T08:00:00Z");
        await order(u, "cancelled", 777, "2019-05-10T08:00:00Z");
        await order(u, "completed", 11, "2019-05-09T21:59:59Z"); // the day before
        await order(u, "completed", 13, "2019-05-10T22:00:00Z"); // the day after
        const w = await window("2019-05-09T22:00:00Z", "2019-05-10T22:00:00Z");
        expect(Number(w.online)).toBe(150.5);
        expect(Number(w.pos)).toBe(0);
      });

      it("is exact beyond a thousand orders (the old app-side sum silently stopped at 1,000 rows)", async () => {
        const u = await mkUser(sql, "customer");
        await sql`INSERT INTO public.orders (user_id, status, total_rand, created_at, payment_method)
                SELECT ${u}, 'completed', 1, '2019-06-10T08:00:00Z', 'card' FROM generate_series(1, 1250)`;
        const w = await window("2019-06-09T22:00:00Z", "2019-06-10T22:00:00Z");
        expect(Number(w.online)).toBe(1250);
      });

      it("takes till refunds off, ignores voided sales, and counts both channels together", async () => {
        const product = await mkProduct(sql, 120);
        await receive(sql, manager, product, 50);
        const { sessionId } = await mkSession(sql, manager, cashier);
        const s1 = await sell(
          sql,
          cashier,
          sessionId,
          [{ product_id: product, quantity: 2 }],
          [cash(240)],
        );
        const s2 = await sell(
          sql,
          cashier,
          sessionId,
          [{ product_id: product, quantity: 1 }],
          [card(120, key("CARD"))],
        );
        const s3 = await sell(
          sql,
          cashier,
          sessionId,
          [{ product_id: product, quantity: 1 }],
          [cash(120)],
        );
        await rpc(sql, "pos_void_sale", manager, s3.sale_id, "rang up twice", key("void"));
        const line = (
          await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${s2.sale_id}`
        )[0]!["id"];
        await rpc(
          sql,
          "pos_refund_sale",
          manager,
          s2.sale_id,
          sessionId,
          [{ sale_item_id: line, quantity: 1 }],
          [{ method: "card", amount: "120" }],
          "returned",
          true,
          key("rf"),
        );
        const u = await mkUser(sql, "customer");
        const at = "2019-07-10 10:30:00+02";
        const o = await order(u, "ready", 80, at).then(() => null);
        expect(o).toBeNull();
        await sql.begin(async (tx) => {
          await tx`SET LOCAL session_replication_role = replica`;
          await tx`UPDATE public.pos_sales SET created_at = ${at} WHERE id IN ${tx([s1.sale_id, s2.sale_id, s3.sale_id])}`;
          await tx`UPDATE public.pos_refunds SET created_at = ${at} WHERE sale_id = ${s2.sale_id}`;
        });
        const w = await window("2019-07-09T22:00:00Z", "2019-07-10T22:00:00Z");
        expect(Number(w.pos)).toBe(240); // 240 + 120 - 120 refunded; the voided 120 is left out
        expect(Number(w.online)).toBe(80);
      });
    });

    describe("admin_overview", () => {
      it("returns today, the week, the month and all time, seven SAST days, top sellers and counts", async () => {
        const product = await mkProduct(sql, 10);
        await sql`UPDATE public.products SET name = ${"Bestseller " + tag} WHERE id = ${product}`;
        await receive(sql, manager, product, 600);
        const { sessionId } = await mkSession(sql, manager, cashier);
        await sell(sql, cashier, sessionId, [{ product_id: product, quantity: 500 }], [cash(5000)]);
        const o = await rpc(sql, "admin_overview", cashier);
        for (const k of ["today", "week", "month", "all_time"])
          expect(Object.keys(o[k]).sort(), k).toEqual(["online", "pos"]);
        expect(Number(o.today.pos)).toBeGreaterThanOrEqual(5000);
        expect(Number(o.week.pos)).toBeGreaterThanOrEqual(Number(o.today.pos));
        expect(Number(o.all_time.pos)).toBeGreaterThanOrEqual(Number(o.week.pos));
        expect(o.daily).toHaveLength(7);
        const days = o.daily.map((d: { day: string }) => d.day);
        expect([...days].sort()).toEqual(days);
        const sast = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
        expect(days.at(-1)).toBe(sast);
        expect(o.top_products.length).toBeLessThanOrEqual(5);
        expect(o.top_products[0]).toMatchObject({ name: "Bestseller " + tag, qty: 500 });
        expect(Object.keys(o.counts).sort()).toEqual([
          "customers",
          "online_orders",
          "paid_online",
          "till_sales",
        ]);
      });

      it("the customer count leaves staff out", async () => {
        const before = (await rpc(sql, "admin_overview", cashier)).counts.customers as number;
        await mkUser(sql, "customer");
        await mkUser(sql, "manager");
        const after = (await rpc(sql, "admin_overview", cashier)).counts.customers as number;
        expect(after - before).toBeGreaterThanOrEqual(1);
        const staff = (
          await sql`SELECT count(*)::int AS n FROM public.user_roles ur WHERE ur.role = 'customer'
        AND EXISTS (SELECT 1 FROM public.user_roles s WHERE s.user_id = ur.user_id AND s.role IN ('budtender','manager','admin'))`
        )[0]!["n"];
        const all = (
          await sql`SELECT count(*)::int AS n FROM public.user_roles WHERE role = 'customer'`
        )[0]!["n"];
        expect(after).toBeLessThanOrEqual(all - staff);
      });

      it("is for staff only", async () => {
        const member = await mkUser(sql, "customer");
        expect(failedWith(await attempt(rpc(sql, "admin_overview", member)), "forbidden")).toBe(
          true,
        );
        expect(
          failedWith(await attempt(rpc(sql, "admin_overview", crypto.randomUUID())), "forbidden"),
        ).toBe(true);
      });
    });

    describe("admin_customers_page", () => {
      const ids: Record<string, string> = {};
      beforeAll(async () => {
        for (const [k, name, phone] of [
          ["a", `Zanele ${tag}`, "0821110001"],
          ["b", `Zodwa ${tag}`, "0821110002"],
          ["c", `Zinhle ${tag}`, "0821110003"],
        ] as const) {
          ids[k] = await mkMember(sql);
          await sql`INSERT INTO public.profiles (id, full_name, phone) VALUES (${ids[k]!}, ${name}, ${phone})
                  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone`;
        }
      });
      const page = (search: string | null, limit = 25, offset = 0, actor = cashier) =>
        rpc(sql, "admin_customers_page", actor, search, limit, offset);

      it("searches name, phone and email, and pages", async () => {
        expect((await page(tag)).total).toBe(3);
        expect((await page("zodwa " + tag)).rows.map((r: { id: string }) => r.id)).toEqual([
          ids["b"],
        ]);
        expect((await page("0821110003")).rows.map((r: { id: string }) => r.id)).toEqual([
          ids["c"],
        ]);
        const email = (await sql`SELECT email FROM auth.users WHERE id = ${ids["a"]!}`)[0]![
          "email"
        ];
        expect((await page(String(email).toUpperCase())).rows[0].id).toBe(ids["a"]);
        const first = await page(tag, 2, 0);
        const second = await page(tag, 2, 2);
        expect(first.total).toBe(3);
        expect(first.rows).toHaveLength(2);
        expect(second.rows).toHaveLength(1);
        const all = [...first.rows, ...second.rows].map((r: { id: string }) => r.id);
        expect(new Set(all).size).toBe(3);
      });

      it("treats % and _ literally, caps the page size, and leaves staff out", async () => {
        expect((await page("%")).total).toBe(0);
        expect((await page("_")).total).toBe(0);
        expect((await page(null, 100000, 0)).rows.length).toBeLessThanOrEqual(100);
        expect((await page(null, -5, -5)).rows.length).toBeGreaterThanOrEqual(1);
        const staffEmail = (await sql`SELECT email FROM auth.users WHERE id = ${manager}`)[0]![
          "email"
        ];
        expect((await page(String(staffEmail))).total).toBe(0);
        expect(failedWith(await attempt(page("x".repeat(101))), "invalid_input")).toBe(true);
      });

      it("spend and orders count paid orders only", async () => {
        const product = await mkProduct(sql, 60);
        await receive(sql, manager, product, 20);
        const paid = await placeOrder(sql, ids["a"]!, [{ product_id: product, quantity: 1 }]);
        await payOrder(sql, paid.orderId);
        await placeOrder(sql, ids["b"]!, [{ product_id: product, quantity: 1 }]); // left unpaid
        const rows = (await page(tag)).rows as {
          id: string;
          order_count: number;
          spend_rand: number;
        }[];
        const a = rows.find((r) => r.id === ids["a"])!;
        const b = rows.find((r) => r.id === ids["b"])!;
        expect(a.order_count).toBe(1);
        expect(Number(a.spend_rand)).toBe(paid.total);
        expect(b).toMatchObject({ order_count: 0 });
        expect(Number(b.spend_rand)).toBe(0);
      });

      it("is for staff only", async () => {
        expect(failedWith(await attempt(page(null, 25, 0, ids["a"]!)), "forbidden")).toBe(true);
      });
    });

    describe("archiving orders", () => {
      const archive = (
        actor: string,
        orderId: string,
        archived = true,
        reason = "test order",
        k = key("ar"),
      ) => rpc(sql, "admin_set_order_archived", actor, orderId, archived, reason, k);

      it("cancels an unpaid order (releasing its stock), archives it, and can undo", async () => {
        const product = await mkProduct(sql, 40);
        await receive(sql, manager, product, 10);
        const member = await mkMember(sql);
        const { orderId } = await placeOrder(sql, member, [{ product_id: product, quantity: 3 }]);
        const held = () =>
          sql`SELECT held FROM public.inventory_availability WHERE product_id = ${product}`.then(
            (r) => Number(r[0]!["held"]),
          );
        expect(await held()).toBe(3);
        const k = key("ar");
        expect(await archive(manager, orderId, true, "unpaid test order", k)).toMatchObject({
          changed: true,
          archived: true,
        });
        expect((await archive(manager, orderId, true, "unpaid test order", k)).replayed).toBe(true);
        const [o] =
          await sql`SELECT status, archived_at, archived_by, archive_reason FROM public.orders WHERE id = ${orderId}`;
        expect(o).toMatchObject({
          status: "cancelled",
          archived_by: manager,
          archive_reason: "unpaid test order",
        });
        expect(o!["archived_at"]).toBeTruthy();
        expect(await held()).toBe(0);
        await assertInventoryConsistent(sql);
        expect((await archive(manager, orderId, true, "again")).changed).toBe(false);
        expect(await archive(admin, orderId, false, "restored by mistake")).toMatchObject({
          changed: true,
          archived: false,
        });
        expect(
          (await sql`SELECT archived_at FROM public.orders WHERE id = ${orderId}`)[0]![
            "archived_at"
          ],
        ).toBeNull();
        const actions =
          await sql`SELECT action FROM public.audit_log WHERE entity_id = ${orderId} AND action IN ('order_archived','order_unarchived') ORDER BY created_at`;
        expect(actions.map((a) => a["action"])).toEqual(["order_archived", "order_unarchived"]);
      });

      it("never archives a paid or in-progress order, needs a manager and a reason", async () => {
        const product = await mkProduct(sql, 40);
        await receive(sql, manager, product, 10);
        const member = await mkMember(sql);
        const paid = await placeOrder(sql, member, [{ product_id: product, quantity: 1 }]);
        await payOrder(sql, paid.orderId);
        expect(
          failedWith(await attempt(archive(manager, paid.orderId)), "invalid_order_state"),
        ).toBe(true);
        // An order that still reads "awaiting payment" but has a succeeded payment is refused too.
        const odd = await placeOrder(sql, member, [{ product_id: product, quantity: 1 }]);
        await sql`INSERT INTO public.payment_transactions (order_id, provider, status, order_total_rand, expected_amount, expected_currency)
                VALUES (${odd.orderId}, 'payfast', 'succeeded', ${odd.total}, ${odd.total}, 'ZAR')`;
        expect(failedWith(await attempt(archive(manager, odd.orderId)), "order_paid")).toBe(true);
        const open = await placeOrder(sql, member, [{ product_id: product, quantity: 1 }]);
        expect(failedWith(await attempt(archive(cashier, open.orderId)), "forbidden")).toBe(true);
        expect(
          failedWith(await attempt(archive(manager, open.orderId, true, "  ")), "reason_required"),
        ).toBe(true);
        expect(
          failedWith(await attempt(archive(manager, crypto.randomUUID())), "order_not_found"),
        ).toBe(true);
        for (const id of [paid.orderId, odd.orderId, open.orderId])
          expect(
            (await sql`SELECT archived_at FROM public.orders WHERE id = ${id}`)[0]!["archived_at"],
          ).toBeNull();
      });
    });

    describe("attention counts and automatic alerts", () => {
      const K = `alert:test-${tag}`;
      const sync = (n: number) =>
        sql`SELECT public._team_alert_sync(${K}, ${n}, 'alert', 'budtender', 'Test alert', ${"n=" + n}) AS r`.then(
          (x) => x[0]!["r"] as boolean,
        );
      const row = () =>
        sql`SELECT * FROM public.team_notifications WHERE source_key = ${K}`.then((r) => r[0]);

      it("counts are for staff and have the expected keys", async () => {
        const c = await rpc(sql, "admin_attention_counts", cashier);
        expect(Object.keys(c).sort()).toEqual([
          "eft_waiting",
          "id_checks",
          "low_stock",
          "orders_to_pack",
          "variances",
        ]);
        for (const v of Object.values(c)) expect(typeof v).toBe("number");
        const member = await mkUser(sql, "customer");
        expect(
          failedWith(await attempt(rpc(sql, "admin_attention_counts", member)), "forbidden"),
        ).toBe(true);
      });

      it("an alert appears, updates in place, is unread again only when it grows, and archives when it clears", async () => {
        expect(await sync(2)).toBe(true);
        const first = await row();
        expect(first).toMatchObject({ status: "published", alert_count: 2, body: "n=2" });
        expect(await sync(2)).toBe(false); // nothing changed
        await new Promise((r) => setTimeout(r, 15));
        expect(await sync(4)).toBe(true);
        const grown = await row();
        expect(new Date(grown!["updated_at"]).getTime()).toBeGreaterThan(
          new Date(first!["updated_at"]).getTime(),
        );
        expect(grown!["id"]).toBe(first!["id"]);
        await new Promise((r) => setTimeout(r, 15));
        expect(await sync(1)).toBe(true); // shrinks quietly
        const shrunk = await row();
        expect(shrunk).toMatchObject({ alert_count: 1, body: "n=1" });
        expect(new Date(shrunk!["updated_at"]).getTime()).toBe(
          new Date(grown!["updated_at"]).getTime(),
        );
        expect(await sync(0)).toBe(true);
        expect((await row())!["status"]).toBe("archived");
        expect(await sync(0)).toBe(false);
        await new Promise((r) => setTimeout(r, 15));
        expect(await sync(3)).toBe(true); // it came back
        const back = await row();
        expect(back!["status"]).toBe("published");
        expect(new Date(back!["updated_at"]).getTime()).toBeGreaterThan(
          new Date(shrunk!["updated_at"]).getTime(),
        );
        const rows =
          await sql`SELECT count(*)::int AS n FROM public.team_notifications WHERE source_key = ${K}`;
        expect(rows[0]!["n"]).toBe(1);
      });

      it("people cannot edit or archive an automatic alert", async () => {
        await sync(2);
        const id = (await row())!["id"] as string;
        const save = (actor: string) =>
          rpc(
            sql,
            "team_notification_save",
            actor,
            id,
            "Edited",
            "By hand",
            "alert",
            "budtender",
            "archived",
            false,
            null,
            null,
            null,
            key("n"),
          );
        const r = await attempt(save(manager));
        expect(!r.ok && r.message.startsWith("alert_readonly")).toBe(true);
        expect(
          (
            await attempt(
              Promise.resolve(
                sql`UPDATE public.team_notifications SET title = 'x' WHERE id = ${id}`,
              ),
            )
          ).ok,
        ).toBe(false);
        expect((await row())!["title"]).toBe("Test alert");
      });

      it("the refresh runs, keeps one row per condition, and writes counts only", async () => {
        const changed = (await sql`SELECT public.team_alerts_refresh() AS n`)[0]!["n"];
        expect(typeof changed).toBe("number");
        const again = (await sql`SELECT public.team_alerts_refresh() AS n`)[0]!["n"];
        expect(again).toBeLessThanOrEqual(changed + 5);
        const dup =
          await sql`SELECT source_key FROM public.team_notifications WHERE source_key IS NOT NULL GROUP BY source_key HAVING count(*) > 1`;
        expect(dup).toHaveLength(0);
        const bodies =
          await sql`SELECT body FROM public.team_notifications WHERE source_key LIKE 'alert:%' AND source_key NOT LIKE 'alert:test-%'`;
        for (const b of bodies)
          expect(String(b["body"])).toMatch(/^\d+ [a-zA-Z -]+(is|are|has|have) /);
      });

      it("an ID check waiting shows up in the counts (the alert is created by the refresh)", async () => {
        const before = (await rpc(sql, "admin_attention_counts", cashier)).id_checks as number;
        const m = await mkUser(sql, "customer");
        await sql`INSERT INTO public.customer_verification (user_id, status, document_path, document_type, declared_dob, submitted_at)
                VALUES (${m}, 'pending', 'x/y.jpg', 'sa_id', '1990-01-01', now())
                ON CONFLICT (user_id) DO UPDATE SET status = 'pending', document_path = 'x/y.jpg', document_type = 'sa_id',
                  declared_dob = '1990-01-01', submitted_at = now()`;
        const after = (await rpc(sql, "admin_attention_counts", cashier)).id_checks as number;
        expect(after).toBeGreaterThanOrEqual(before + 1);
        await sql`SELECT public.team_alerts_refresh()`;
        const alert = (
          await sql`SELECT status, min_role FROM public.team_notifications WHERE source_key = 'alert:id-checks'`
        )[0];
        expect(alert).toMatchObject({ status: "published", min_role: "budtender" });
      });
    });

    it("staff_directory now includes the last sign-in", async () => {
      await sql`UPDATE auth.users SET last_sign_in_at = '2026-10-27T08:00:00Z' WHERE id = ${cashier}`;
      const dir = await rpc(sql, "staff_directory", manager);
      const me = dir.find((x: { user_id: string }) => x.user_id === cashier);
      expect(new Date(me.last_sign_in).toISOString()).toBe("2026-10-27T08:00:00.000Z");
    });

    it("mutation check: weakening each new rule makes the matching attack succeed", async () => {
      const rolledBack = Symbol("rollback");
      const inRollback = async (fn: (tx: Sql) => Promise<unknown>) => {
        let out: unknown;
        await sql
          .begin(async (tx) => {
            out = await fn(tx as unknown as Sql);
            throw rolledBack;
          })
          .catch((e) => {
            if (e !== rolledBack) throw e;
          });
        return out;
      };
      // 1. Browser roles may not run the overview or archive functions: with the grants restored, they could.
      const granted = await inRollback(async (tx) => {
        await tx`GRANT EXECUTE ON FUNCTION public.admin_set_order_archived(uuid, uuid, boolean, text, text) TO authenticated`;
        await tx`SET LOCAL ROLE authenticated`;
        return (
          await attempt(
            tx`SELECT public.admin_set_order_archived(${manager}, ${crypto.randomUUID()}, true, 'mutation', 'mutation-key-1')`,
          )
        ).ok;
      });
      // the call is now allowed to run, so it fails inside the function (order_not_found), not on the grant
      expect(granted).toBe(false);
      const denied = await attempt(
        Promise.resolve(
          sql.begin(async (tx) => {
            await tx`SET LOCAL ROLE authenticated`;
            await tx`SELECT public.admin_set_order_archived(${manager}, ${crypto.randomUUID()}, true, 'mutation', 'mutation-key-2')`;
          }),
        ),
      );
      expect(!denied.ok && /permission denied/i.test(denied.message)).toBe(true);
      // 2. The alert guard: with the trigger switched off, a manager could rewrite an automatic alert.
      await sql`SELECT public._team_alert_sync(${"alert:mut-" + tag}, 1, 'alert', 'budtender', 'Guarded', 'n=1')`;
      const id = (
        await sql`SELECT id FROM public.team_notifications WHERE source_key = ${"alert:mut-" + tag}`
      )[0]!["id"];
      const rewritten = await inRollback(async (tx) => {
        await tx`ALTER TABLE public.team_notifications DISABLE TRIGGER team_alert_guard`;
        return (
          await attempt(
            Promise.resolve(
              tx`UPDATE public.team_notifications SET title = 'forged' WHERE id = ${id}`,
            ),
          )
        ).ok;
      });
      expect(rewritten).toBe(true);
      expect(
        (await sql`SELECT title FROM public.team_notifications WHERE id = ${id}`)[0]!["title"],
      ).toBe("Guarded");
      // 3. A paid order is protected by the payment check: with the check bypassed (payment marked pending), it archives.
      const product = await mkProduct(sql, 30);
      await receive(sql, manager, product, 5);
      const member = await mkMember(sql);
      const paid = await placeOrder(sql, member, [{ product_id: product, quantity: 1 }]);
      await payOrder(sql, paid.orderId);
      const refused = await attempt(
        rpc(sql, "admin_set_order_archived", manager, paid.orderId, true, "mutation", key("ar")),
      );
      expect(!refused.ok).toBe(true);
    });
  },
);
