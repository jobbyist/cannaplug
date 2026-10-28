import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asUser,
  attempt,
  card,
  cash,
  connect,
  key,
  mkProduct,
  mkSession,
  mkUser,
  receive,
  rpc,
  sell,
  val,
  type Sql,
} from "./helpers";

/**
 * Till cash-up: expenses paid from the till, discounts, the bank deposit and the float carried to the next day,
 * all fixed by the database at close so the closing amount reconciles.
 */
describe.skipIf(!DB_URL)("till cash-up (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;
  let other: string;
  let product: string;
  // A quiet historic day, so the report section only sees this file's sessions.
  const DAY = new Date(Date.UTC(1991, 0, 1) + Math.floor(Math.random() * 3600) * 86_400_000)
    .toISOString()
    .slice(0, 10);

  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
    cashier = await mkUser(sql, "budtender");
    other = await mkUser(sql, "budtender");
    product = await mkProduct(sql, 100);
    await receive(sql, manager, product, 200);
  });
  afterAll(async () => {
    await sql.end();
  });

  const expense = (
    actor: string,
    session: string,
    amount: number | string,
    category = "supplies",
    description = "Cleaning cloths",
    idem = key("exp"),
  ) => rpc(sql, "pos_add_expense", actor, session, amount, category, description, idem);
  const close = (
    actor: string,
    session: string,
    counted: number | string,
    deposited: number | string,
    note: string | null = null,
    idem = key("close"),
  ) => rpc(sql, "pos_close_session", actor, session, counted, deposited, note, idem);

  it("reconciles: float + cash taken (after discounts) - refunds - expenses; deposit leaves tomorrow's float", async () => {
    const { sessionId, drawerId } = await mkSession(sql, manager, cashier, 500);
    // R300 cash sale with R30 off (paid R270), and a R100 card sale.
    await sell(sql, cashier, sessionId, [{ product_id: product, quantity: 3 }], [cash(270)], {
      orderDiscount: { kind: "amount", value: "30" },
      reason: "Regular customer",
    });
    await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: product, quantity: 1 }],
      [card(100, key("C"))],
    );
    await expense(cashier, sessionId, 45.5, "cleaning", "Mop and bucket");
    const mistake = await expense(cashier, sessionId, 999, "other", "Typo amount");
    await rpc(sql, "pos_void_expense", cashier, mistake.expense_id, "entered by mistake", key("v"));

    // Expected = 500 + 270 - 0 - 45.50 = 724.50. Counted 724.50, R600 to the bank, R124.50 stays as float.
    const r = await close(cashier, sessionId, "724.50", "600.00", "all good");
    expect(r).toMatchObject({ approval_status: "not_required" });
    expect(Number(r.opening_float)).toBe(500);
    expect(Number(r.cash_sales)).toBe(270);
    expect(Number(r.discounts_total)).toBe(30);
    expect(Number(r.expenses_total)).toBe(45.5);
    expect(Number(r.expected_cash)).toBe(724.5);
    expect(Number(r.variance)).toBe(0);
    expect(Number(r.cash_deposited)).toBe(600);
    expect(Number(r.float_carried)).toBe(124.5);
    const [row] = await sql`SELECT * FROM public.pos_sessions WHERE id = ${sessionId}`;
    expect(Number(row!["float_carried"])).toBe(124.5);
    expect(row!["drawer_id"]).toBe(drawerId);
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.audit_log WHERE entity_id = ${sessionId}
              AND action IN ('pos_expense_added', 'pos_expense_voided', 'pos_session_closed')`,
        ),
      ),
    ).toBe(4);
  });

  it("an unrecorded expense shows up as a variance that needs a manager's approval with a reason", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier, 500);
    await sell(sql, cashier, sessionId, [{ product_id: product, quantity: 2 }], [cash(200)]);
    const r = await close(cashier, sessionId, 650, 0); // R50 spent but not recorded
    expect(Number(r.variance)).toBe(-50);
    expect(r.approval_status).toBe("pending");
    expect(
      (await attempt(rpc(sql, "pos_review_session", cashier, sessionId, true, "self"))).ok,
    ).toBe(false);
    const ok = await rpc(
      sql,
      "pos_review_session",
      manager,
      sessionId,
      true,
      "Store expenses and discounts not captured",
    );
    expect(ok.approval_status).toBe("approved");
  });

  it("refuses a deposit larger than the count, negative amounts, and expenses on someone else's or a closed till", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier, 100);
    const big = await attempt(close(cashier, sessionId, 100, 150));
    expect(!big.ok && big.message).toMatch(/deposit cannot be more/);
    expect((await attempt(close(cashier, sessionId, 100, -1))).ok).toBe(false);
    expect((await attempt(expense(cashier, sessionId, 0))).ok).toBe(false);
    expect((await attempt(expense(cashier, sessionId, 10, "bribes"))).ok).toBe(false);
    expect((await attempt(expense(cashier, sessionId, 10, "other", "x"))).ok).toBe(false);
    const notMine = await attempt(expense(other, sessionId, 10));
    expect(!notMine.ok && notMine.message).toMatch(/session_not_yours/);
    // A manager may record one on any till.
    expect((await expense(manager, sessionId, 10)).expense_id).toBeTruthy();
    const e = await expense(cashier, sessionId, 5);
    const voidOther = await attempt(
      rpc(sql, "pos_void_expense", other, e.expense_id, "nope", key("v")),
    );
    expect(!voidOther.ok && voidOther.message).toMatch(/forbidden/);

    await close(cashier, sessionId, 85, 0);
    const late = await attempt(expense(cashier, sessionId, 10));
    expect(!late.ok && late.message).toMatch(/session_closed/);
    const lateVoid = await attempt(
      rpc(sql, "pos_void_expense", manager, e.expense_id, "after", key("v")),
    );
    expect(!lateVoid.ok && lateVoid.message).toMatch(/session_closed/);
  });

  it("the closing figures and the expenses are immutable, even for the service role", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier, 100);
    const e = await expense(cashier, sessionId, 20);
    await close(cashier, sessionId, 80, 30);
    for (const col of [
      "cash_deposited",
      "float_carried",
      "expenses_total",
      "discounts_total",
      "cash_sales",
      "cash_refunds",
    ]) {
      const edit = await attempt(
        sql.unsafe(`UPDATE public.pos_sessions SET ${col} = 12345.67 WHERE id = $1`, [sessionId]),
      );
      expect(!edit.ok && edit.message, col).toMatch(/immutable/);
    }
    // While the till is still open, an expense can only be voided (through the RPC), never edited.
    const open = await mkSession(sql, manager, cashier, 100);
    const e2 = await expense(cashier, open.sessionId, 20);
    const sneak = await attempt(
      sql`UPDATE public.pos_session_expenses SET amount = 1 WHERE id = ${e2.expense_id}`,
    );
    expect(!sneak.ok && sneak.message).toMatch(/only be voided/);
    const edit2 = await attempt(
      sql`UPDATE public.pos_session_expenses SET amount = 1 WHERE id = ${e.expense_id}`,
    );
    expect(edit2.ok).toBe(false);
    const del = await attempt(
      sql`DELETE FROM public.pos_session_expenses WHERE id = ${e.expense_id}`,
    );
    expect(del.ok).toBe(false);
  });

  it("closing is idempotent per key, and the old five-argument close still works (no deposit)", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier, 100);
    const k = key("close");
    const a = await close(cashier, sessionId, 100, 40, null, k);
    const b = await close(cashier, sessionId, 100, 40, null, k);
    expect(b.replayed).toBe(true);
    expect(b.float_carried).toEqual(a.float_carried);
    const s2 = await mkSession(sql, manager, cashier, 100);
    const old = await rpc(sql, "pos_close_session", cashier, s2.sessionId, 100, null, key("c"));
    expect(Number(old.cash_deposited)).toBe(0);
    expect(Number(old.float_carried)).toBe(100);
  });

  it("browser roles can read expenses as staff but never write them; customers see nothing", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier, 100);
    await expense(cashier, sessionId, 12);
    const seen = await asUser(
      sql,
      cashier,
      (tx) =>
        tx`SELECT count(*)::int AS n FROM public.pos_session_expenses WHERE session_id = ${sessionId}`,
    );
    expect(seen[0]!["n"]).toBe(1);
    const customer = await mkUser(sql, "customer");
    const hidden = await asUser(
      sql,
      customer,
      (tx) => tx`SELECT count(*)::int AS n FROM public.pos_session_expenses`,
    );
    expect(hidden[0]!["n"]).toBe(0);
    // No browser role holds a write privilege at all (RLS is the second lock).
    for (const role of ["anon", "authenticated"])
      for (const priv of ["INSERT", "UPDATE", "DELETE"])
        expect(
          await val(
            sql`SELECT has_table_privilege(${role}, 'public.pos_session_expenses', ${priv})`,
          ),
          `${role} ${priv}`,
        ).toBe(false);
    const write = await attempt(
      asUser(
        sql,
        cashier,
        (tx) =>
          tx`INSERT INTO public.pos_session_expenses (session_id, amount, category, description, created_by)
           VALUES (${sessionId}, 1, 'other', 'sneaky', ${cashier})`,
      ),
    );
    expect(write.ok).toBe(false);
    const call = await attempt(
      asUser(
        sql,
        cashier,
        (tx) =>
          tx`SELECT public.pos_add_expense(${cashier}::uuid, ${sessionId}::uuid, 1, 'other', 'sneaky', 'k-direct-1')`,
      ),
    );
    expect(call.ok).toBe(false);
  });

  it("the sales report carries discounts, expenses, deposits, variances and each cash-up; product revenue is after discounts", async () => {
    const { sessionId } = await mkSession(sql, manager, cashier, 300);
    const p = await mkProduct(sql, 200);
    await sql`UPDATE public.products SET name = 'Cashup Kush' WHERE id = ${p}`;
    await receive(sql, manager, p, 10);
    const s = await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: p, quantity: 2, discount: { kind: "percent", value: "10" } }],
      [cash(360)],
      { reason: "Staff discount" },
    );
    const e = await expense(cashier, sessionId, 40, "food", "Staff lunch");
    await close(cashier, sessionId, 600, 500); // expected 300 + 360 - 40 = 620 -> variance -20
    // Move this file's rows onto DAY.
    const at = `${DAY} 18:00:00+02`;
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE public.pos_sales SET created_at = ${at} WHERE id = ${s.sale_id}`;
      await tx`UPDATE public.pos_session_expenses SET created_at = ${at} WHERE id = ${e.expense_id}`;
      await tx`UPDATE public.pos_sessions SET closed_at = ${at}, opened_at = ${`${DAY} 08:00:00+02`} WHERE id = ${sessionId}`;
    });
    const r = await rpc(sql, "sales_report", cashier, DAY, DAY);
    expect(r.pos).toMatchObject({ count: 1, discounted_count: 1 });
    expect(Number(r.pos.before_discounts)).toBe(400);
    expect(Number(r.pos.discounts)).toBe(40);
    expect(Number(r.pos.gross)).toBe(360);
    expect(r.products.find((x: any) => x.name === "Cashup Kush")).toMatchObject({ qty: 2 });
    expect(Number(r.products.find((x: any) => x.name === "Cashup Kush").revenue)).toBe(360);
    expect(Number(r.till.sessions_closed)).toBe(1);
    expect(Number(r.till.expenses)).toBe(40);
    expect(Number(r.till.deposited)).toBe(500);
    expect(Number(r.till.float_carried)).toBe(100);
    expect(Number(r.till.variance)).toBe(-20);
    expect(Number(r.till.variances_pending)).toBe(1);
    expect(r.till_sessions).toHaveLength(1);
    expect(r.till_sessions[0]).toMatchObject({ approval: "pending" });
    expect(Number(r.till_sessions[0].expected)).toBe(620);
    expect(r.expenses).toEqual([
      expect.objectContaining({ category: "food", description: "Staff lunch" }),
    ]);
  });
});
