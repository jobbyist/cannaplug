import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  asUser,
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

/**
 * Ask The Plug matching and stock guardrails on real PostgreSQL (spec layers 1-4 and 8): the one stock reader
 * (plug_match_candidates) can never return a product that is inactive, not sold online, needing a practitioner
 * recommendation, out of stock, expired, fully held or below the safety buffer; fast sellers need a higher buffer;
 * a hold taken a moment before the read removes the product; settings are manager-only; sold-out Reserves alert staff.
 */
describe.skipIf(!DB_URL)("Ask The Plug matching (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let admin: string;
  let member: string;

  const offered = async (...ids: string[]) =>
    ((await sql`SELECT id FROM public.plug_match_candidates(NULL)`) as { id: string }[])
      .map((r) => r.id)
      .filter((id) => ids.includes(id));
  const logEvent = (kind: string, outcome: string, answers: object, ids: string[]) =>
    sql`SELECT public.plug_match_log(${kind}, ${outcome}, ${sql.json(answers as never)}, ${ids}::uuid[])`;
  const setBuffers = (d: number, f: number, u: number) =>
    rpc(sql, "plug_settings_set", manager, d, f, u, key("plug-set"));

  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
    admin = await mkUser(sql, "admin");
    member = await mkMember(sql);
    await setBuffers(2, 4, 10);
  });
  afterAll(async () => {
    await setBuffers(2, 4, 10);
    await sql.end();
  });

  it("starts from the defaults: normal buffer 2, fast sellers 4 after 10 units in 7 days", async () => {
    const [s] =
      await sql`SELECT buffer_default, buffer_fast, fast_seller_units_7d FROM public.plug_settings`;
    expect(s).toEqual({ buffer_default: 2, buffer_fast: 4, fast_seller_units_7d: 10 });
  });

  it("offers a product with stock at or above the buffer, with the live count", async () => {
    const p = await mkProduct(sql, 60);
    await receive(sql, manager, p, 2);
    const [row] =
      await sql`SELECT available, buffer, fast_seller FROM public.plug_match_candidates(NULL) WHERE id = ${p}`;
    expect(row).toMatchObject({ available: 2, buffer: 2, fast_seller: false });
  });

  it("never returns: out of stock, below the buffer, inactive, not sold online, needs a recommendation", async () => {
    const none = await mkProduct(sql);
    const one = await mkProduct(sql);
    await receive(sql, manager, one, 1); // below the buffer of 2
    const inactive = await mkProduct(sql);
    const offline = await mkProduct(sql);
    const medical = await mkProduct(sql);
    for (const p of [inactive, offline, medical]) await receive(sql, manager, p, 10);
    await sql`UPDATE public.products SET is_active = false WHERE id = ${inactive}`;
    await sql`UPDATE public.products SET sell_online = false WHERE id = ${offline}`;
    await sql`UPDATE public.products SET requires_recommendation = true WHERE id = ${medical}`;
    expect(await offered(none, one, inactive, offline, medical)).toEqual([]);
  });

  it("never returns stock that has expired", async () => {
    const p = await mkProduct(sql);
    await receive(sql, manager, p, 10, undefined, new Date(Date.now() + 2 * 86_400_000));
    expect(await offered(p)).toEqual([p]);
    await sql`UPDATE public.inventory_batches SET expires_at = now() - interval '1 day' WHERE product_id = ${p}`;
    expect(await offered(p)).toEqual([]);
  });

  it("never returns stock that is fully held by an order, and returns it again when the order is cancelled", async () => {
    const p = await mkProduct(sql);
    await receive(sql, manager, p, 5);
    expect(await offered(p)).toEqual([p]);
    const { orderId } = await placeOrder(sql, member, [{ product_id: p, quantity: 4 }]); // 1 left < buffer
    expect(await offered(p)).toEqual([]);
    await rpc(sql, "transition_order_status", orderId, "cancelled", manager, null);
    expect(await offered(p)).toEqual([p]);
  });

  it("race: the last units are held a moment before the read, so the product is gone from that read", async () => {
    const p = await mkProduct(sql);
    await receive(sql, manager, p, 3);
    expect(await offered(p)).toEqual([p]); // the member's card is built from this
    await placeOrder(sql, member, [{ product_id: p, quantity: 2 }]); // another member checks out first
    expect(await offered(p)).toEqual([]); // Reserve's re-check and the next match both see it gone
  });

  it("fast sellers need the higher buffer: the same stock is offered for a slow product and hidden for a fast one", async () => {
    await setBuffers(2, 5, 3); // 3 units in 7 days is a fast seller for this test
    const cashier = await mkUser(sql, "budtender");
    const { sessionId } = await mkSession(sql, manager, cashier);
    const slow = await mkProduct(sql, 40);
    const fast = await mkProduct(sql, 40);
    await receive(sql, manager, slow, 4);
    await receive(sql, manager, fast, 10);
    await sell(sql, cashier, sessionId, [{ product_id: fast, quantity: 5 }], [cash(200)]); // 5 sold, 5 left
    const [row] =
      await sql`SELECT units_7d, fast_seller, buffer, available FROM public.plug_match_candidates(NULL) WHERE id = ${fast}`;
    expect(row).toMatchObject({ units_7d: 5, fast_seller: true, buffer: 5, available: 5 });
    expect(await offered(fast, slow)).toEqual(expect.arrayContaining([fast, slow])); // 5 >= 5 and 4 >= 2
    await sell(sql, cashier, sessionId, [{ product_id: fast, quantity: 1 }], [cash(40)]); // 4 left < 5
    expect(await offered(fast, slow)).toEqual([slow]);
    await setBuffers(2, 4, 10);
  });

  it("refunded and voided units do not make a product a fast seller", async () => {
    await setBuffers(2, 4, 3);
    const cashier = await mkUser(sql, "budtender");
    const { sessionId } = await mkSession(sql, manager, cashier);
    const p = await mkProduct(sql, 30);
    await receive(sql, manager, p, 20);
    const sale = await sell(sql, cashier, sessionId, [{ product_id: p, quantity: 6 }], [cash(180)]);
    await rpc(sql, "pos_void_sale", manager, sale.sale_id, "test", key("void")).catch(
      () => undefined,
    );
    const [row] =
      await sql`SELECT fast_seller FROM public.plug_match_candidates(NULL) WHERE id = ${p}`;
    expect(row?.["fast_seller"]).toBe(false);
    await setBuffers(2, 4, 10);
  });

  it("filters by category", async () => {
    const p = await mkProduct(sql);
    await receive(sql, manager, p, 5);
    const rows = (await sql`SELECT id FROM public.plug_match_candidates(ARRAY['Edibles'])`) as {
      id: string;
    }[];
    expect(rows.some((r) => r.id === p)).toBe(false);
  });

  it("the safety buffer is editable by a manager only, validated, idempotent and audited", async () => {
    const budtender = await mkUser(sql, "budtender");
    expect(
      failedWith(
        await attempt(rpc(sql, "plug_settings_set", budtender, 3, 6, 12, key("x"))),
        "forbidden",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(rpc(sql, "plug_settings_set", member, 3, 6, 12, key("x"))),
        "forbidden",
      ),
    ).toBe(true);
    for (const bad of [
      [0, 4, 10],
      [3, 2, 10], // fast buffer below the normal one
      [2, 101, 10],
      [2, 4, 0],
    ] as const) {
      expect(
        failedWith(
          await attempt(rpc(sql, "plug_settings_set", manager, ...bad, key("bad"))),
          "invalid_input",
        ),
      ).toBe(true);
    }
    const k = key("ok");
    await rpc(sql, "plug_settings_set", manager, 3, 6, 12, k);
    await rpc(sql, "plug_settings_set", manager, 3, 6, 12, k); // replay
    expect(await val(sql`SELECT buffer_default FROM public.plug_settings`)).toBe(3);
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.audit_log WHERE action = 'plug_settings_set' AND actor_user_id = ${manager}`,
      ),
    ).toBeGreaterThanOrEqual(1);
    await setBuffers(2, 4, 10);
  });

  it("stock failures raise one staff recount alert per product and keep no personal data", async () => {
    const p = await mkProduct(sql);
    await receive(sql, manager, p, 5);
    const answers = { experience: "sometimes", format: "flower" };
    await logEvent("reserve_stock_fail", "sold_out", answers, [p]);
    await logEvent("reserve_stock_fail", "sold_out", answers, [p]);
    const alerts =
      await sql`SELECT title, kind, min_role, alert_count FROM public.team_notifications WHERE source_key = ${"alert:plug-stock:" + p}`;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "alert", min_role: "manager", alert_count: 2 });
    expect(String(alerts[0]!["title"])).toMatch(/^Recount: /);
    const cols =
      (await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'plug_match_events'`) as {
        column_name: string;
      }[];
    expect(cols.map((c) => c.column_name).sort()).toEqual([
      "answers",
      "created_at",
      "id",
      "kind",
      "outcome",
      "product_ids",
    ]);
    expect(
      failedWith(
        await attempt(logEvent("match", "matched", { email: "a@b.co" }, [])),
        "invalid_input",
      ),
    ).toBe(true);
  });

  it("browsers cannot read the settings, the log or call any of the functions", async () => {
    const run = async (fn: (tx: Sql) => Promise<unknown>) => {
      for (const who of [
        (f: typeof fn) => asUser(sql, member, f),
        (f: typeof fn) => asAnon(sql, f),
      ]) {
        expect((await attempt(who(fn))).ok).toBe(false);
      }
    };
    await run((tx) => tx`SELECT * FROM public.plug_settings`);
    await run((tx) => tx`SELECT * FROM public.plug_match_events`);
    await run((tx) => tx`SELECT * FROM public.plug_match_candidates(NULL)`);
    await run((tx) => tx`SELECT public.plug_match_log('match', 'matched', '{}'::jsonb, '{}')`);
    await run((tx) => tx`SELECT public.plug_settings_set(${manager}, 3, 6, 12, 'abcdefgh')`);
  });

  it("mutation check: dropping the buffer filter would offer a one-unit product, so the buffer is what hides it", async () => {
    const p = await mkProduct(sql);
    await receive(sql, manager, p, 1);
    expect(await offered(p)).toEqual([]); // real function: hidden
    const rolledBack = new Error("rollback");
    const out = await sql
      .begin(async (tx) => {
        await tx`UPDATE public.plug_settings SET buffer_default = 1, buffer_fast = 1`; // the mutant: no safety margin
        const rows =
          (await tx`SELECT id FROM public.plug_match_candidates(NULL) WHERE id = ${p}`) as {
            id: string;
          }[];
        throw Object.assign(rolledBack, { rows });
      })
      .catch((e) =>
        e === rolledBack ? (e as Error & { rows: { id: string }[] }).rows : Promise.reject(e),
      );
    expect(out.map((r) => r.id)).toEqual([p]); // the mutant offers it
    expect(await offered(p)).toEqual([]); // and the rollback restores the guard
  });

  it("mutation check: the hard filters are what hide inactive, offline and recommendation-only products", async () => {
    const p = await mkProduct(sql);
    await receive(sql, manager, p, 10);
    await sql`UPDATE public.products SET requires_recommendation = true, sell_online = false, is_active = false WHERE id = ${p}`;
    expect(await offered(p)).toEqual([]);
    for (const col of [
      "requires_recommendation = false",
      "sell_online = true",
      "is_active = true",
    ]) {
      await sql.unsafe(`UPDATE public.products SET ${col} WHERE id = '${p}'`);
    }
    expect(await offered(p)).toEqual([p]); // each flag, once cleared, is the only thing that was hiding it
  });
});
