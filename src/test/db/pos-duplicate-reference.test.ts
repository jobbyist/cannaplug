import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  card,
  cash,
  connect,
  key,
  mkProduct,
  mkSession,
  mkUser,
  receive,
  sell,
  type Sql,
} from "./helpers";

describe.skipIf(!DB_URL)("a card reference can only be used once (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;
  let product: string;
  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
    cashier = await mkUser(sql, "budtender");
    product = await mkProduct(sql, 50);
    await receive(sql, manager, product, 20);
  });
  afterAll(async () => {
    await sql.end();
  });

  const fail = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as { code?: string; message: string };
    }
    throw new Error("expected the sale to be refused");
  };

  it("two payments in one sale with the same reference are refused by the unique index (the app turns this into a plain message)", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier);
    const ref = `SLIP-${key("r")}`;
    const e = await fail(
      sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 1 }],
        [card(25, ref), card(25, ref)],
      ),
    );
    // friendlyPosError matches on exactly this constraint name; keep them in step.
    expect(e.code).toBe("23505");
    expect(e.message).toContain("pos_tenders_reference_uidx");
    const sold =
      await sql`SELECT count(*)::int AS n FROM public.pos_tenders WHERE reference = ${ref}`;
    expect(sold[0]!["n"]).toBe(0); // all or nothing: no half-recorded sale
  });

  it("a reference already used on an earlier sale is refused (payment_reference_in_use), and different references work", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier);
    const ref = `SLIP-${key("r")}`;
    await sell(sql, cashier, sessionId, [{ product_id: product, quantity: 1 }], [card(50, ref)]);
    const e = await fail(
      sell(sql, cashier, sessionId, [{ product_id: product, quantity: 1 }], [card(50, ref)]),
    );
    // an earlier sale's reference is caught by the function itself, with a code the app already maps
    expect(e.message).toMatch(/^payment_reference_in_use/);
    const ok = await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: product, quantity: 1 }],
      [card(25, `SLIP-${key("a")}`), card(25, `SLIP-${key("b")}`)],
    );
    expect(Number(ok.total)).toBe(50);
  });

  it("cash payments have no reference, so two cash payments are fine", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier);
    const r = await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: product, quantity: 1 }],
      [cash(20), cash(30)],
    );
    expect(Number(r.total)).toBe(50);
  });
});
