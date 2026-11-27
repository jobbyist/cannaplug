import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  payOrder,
  asUser,
  attempt,
  connect,
  failedWith,
  key,
  mkMember,
  mkProduct,
  mkUser,
  receive,
  rpc,
  val,
  type Sql,
} from "./helpers";

/**
 * 27 Nov 2026: members can deactivate or delete their account.
 * Deactivate is reversible and stops ordering. Delete anonymises (records that must be kept stay, without the person).
 */
describe.skipIf(!DB_URL)("account deactivation and deletion (real PostgreSQL)", () => {
  let sql: Sql;
  let admin: string;
  let manager: string;
  let product: string;

  beforeAll(async () => {
    sql = connect(10);
    admin = await mkUser(sql, "admin");
    manager = await mkUser(sql, "manager");
    product = await mkProduct(sql, 80);
    await receive(sql, manager, product, 200);
  });
  afterAll(async () => {
    await sql.end();
  });

  const setStatus = (user: string, action: string, k = key("st")) =>
    rpc(sql, "member_account_set_status", user, action, k);
  // The real order gate: checkout_place_order (what the website calls) refuses a deactivated member.
  const order = async (user: string) => {
    const r = await rpc(
      sql,
      "checkout_place_order",
      user,
      [{ product_id: product, quantity: 1 }],
      "Test Person",
      "+27 82 000 0000",
      "collection",
      null,
      "eft",
      80,
      null,
      key("co"),
    );
    return { orderId: (r.order_id ?? r.orderId) as string };
  };
  // A collect-in-store order: paid, then marked completed when the customer collects it.
  const complete = async (orderId: string) => {
    await payOrder(sql, orderId);
    for (const to of ["packing", "ready", "completed"])
      await rpc(sql, "transition_order_status", orderId, to, manager, null);
  };
  const state = (user: string) => rpc(sql, "member_account_state", user);

  it("deactivate stops ordering; reactivate brings it back; both keep points and orders", async () => {
    const m = await mkMember(sql);
    await complete((await order(m)).orderId);
    expect((await state(m)).status).toBe("active");

    const r = await setStatus(m, "deactivate");
    expect(r.status).toBe("deactivated");
    const refused = await attempt(order(m));
    expect(failedWith(refused, "account_deactivated")).toBe(true);

    expect((await setStatus(m, "reactivate")).status).toBe("active");
    await order(m); // ordering works again
    expect(
      await val<number>(sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${m}`),
    ).toBe(2);
  });

  it("repeating the same key changes nothing and says it was a replay", async () => {
    const m = await mkMember(sql);
    const k = key("same");
    await setStatus(m, "deactivate", k);
    const again = await setStatus(m, "deactivate", k);
    expect(again.replayed).toBe(true);
    expect(
      await val<number>(
        sql`SELECT count(*)::int FROM public.audit_log WHERE entity_id = ${m} AND action = 'member_account_deactivated'`,
      ),
    ).toBe(1);
  });

  it("refuses while an order is in progress, and allows it once the order is done", async () => {
    const m = await mkMember(sql);
    const { orderId } = await order(m);
    expect(failedWith(await attempt(setStatus(m, "deactivate")), "open_orders")).toBe(true);
    expect(failedWith(await attempt(setStatus(m, "request_deletion")), "open_orders")).toBe(true);
    await complete(orderId);
    expect((await setStatus(m, "deactivate")).status).toBe("deactivated");
  });

  it("staff accounts cannot use the member buttons", async () => {
    expect(failedWith(await attempt(setStatus(manager, "deactivate")), "staff_account")).toBe(true);
  });

  it("a deletion request deactivates at once, shows first in Customers, and can be cancelled by reactivating", async () => {
    const m = await mkMember(sql);
    const r = await setStatus(m, "request_deletion");
    expect(r.status).toBe("deletion_requested");
    const page = await rpc(sql, "admin_customers_page", admin, null, 25, 0);
    expect(page.rows[0].id).toBe(m);
    expect(page.rows[0].account_status).toBe("deletion_requested");
    expect(failedWith(await attempt(order(m)), "account_deactivated")).toBe(true);
    expect((await setStatus(m, "reactivate")).status).toBe("active");
    expect(
      (await rpc(sql, "admin_customers_page", admin, null, 100, 0)).rows.find(
        (x: { id: string }) => x.id === m,
      ).account_status,
    ).toBe("active");
  });

  it("only an admin completes a deletion, with a reason; managers and members cannot", async () => {
    const m = await mkMember(sql);
    const call = (who: string, reason = "asked by WhatsApp") =>
      rpc(sql, "admin_account_delete", who, m, reason, key("del"));
    expect(failedWith(await attempt(call(manager)), "forbidden")).toBe(true);
    expect(failedWith(await attempt(call(m)), "forbidden")).toBe(true);
    expect(failedWith(await attempt(call(admin, "x")), "invalid_input")).toBe(true);
    expect(failedWith(await attempt(call(admin, "")), "invalid_input")).toBe(true);
    expect(
      await val<boolean>(sql`SELECT deleted_at IS NULL FROM public.profiles WHERE id = ${m}`),
    ).toBe(true);
  });

  it("deleting anonymises the member, keeps orders and receipts, hides them from Customers, and writes a clean audit row", async () => {
    const m = await mkMember(sql);
    const email = await val<string>(sql`SELECT email FROM auth.users WHERE id = ${m}`);
    await sql`UPDATE public.profiles SET full_name = 'Katlego Test', phone = '0821234567', address = '1 Main Rd',
              date_of_birth = '1990-01-01', username = ${`kat_${m.slice(0, 6)}`} WHERE id = ${m}`;
    await sql`INSERT INTO public.addresses (user_id, label, recipient_name, phone, line1, city, province, postal_code)
              VALUES (${m}, 'Home', 'Katlego Test', '0821234567', '1 Main Rd', 'Pretoria', 'Gauteng', '0001')`;
    await sql`INSERT INTO public.member_signup_details (user_id, id_number) VALUES (${m}, '9001015800085')`;
    await sql`INSERT INTO public.newsletter_subscribers (email, consent_source) VALUES (${email}, 'test')`;
    const { orderId } = await order(m);
    await complete(orderId);
    await sql`UPDATE public.orders SET notes = 'leave at gate', contact_phone = '0821234567' WHERE id = ${orderId}`;

    await setStatus(m, "request_deletion");
    const r = await rpc(
      sql,
      "admin_account_delete",
      admin,
      m,
      "Requested by the member",
      key("del"),
    );
    expect(r.kept.orders).toBe(1);
    expect(r.email_placeholder).toMatch(/^deleted-[0-9a-f]{32}@deleted\.invalid$/);

    const [p] =
      await sql`SELECT full_name, phone, address, date_of_birth, username, deleted_at, deactivated_at
                          FROM public.profiles WHERE id = ${m}`;
    expect(p).toMatchObject({
      full_name: "Deleted member",
      phone: null,
      address: null,
      date_of_birth: null,
      username: null,
    });
    expect(p!["deleted_at"]).not.toBeNull();
    expect(
      await val<number>(sql`SELECT count(*)::int FROM public.addresses WHERE user_id = ${m}`),
    ).toBe(0);
    expect(
      await val<number>(
        sql`SELECT count(*)::int FROM public.member_signup_details WHERE user_id = ${m}`,
      ),
    ).toBe(0);
    expect(
      await val<number>(
        sql`SELECT count(*)::int FROM public.newsletter_subscribers WHERE lower(email) = lower(${email})`,
      ),
    ).toBe(0);

    // Records that must be kept are still there, without the person.
    const [o] =
      await sql`SELECT id, status, total_rand, notes, contact_phone FROM public.orders WHERE id = ${orderId}`;
    expect(o).toMatchObject({ status: "completed", notes: null, contact_phone: null });
    expect(Number(o!["total_rand"])).toBeGreaterThan(0);

    // Hidden from Customers, ordering refused, and a second delete is refused.
    const page = await rpc(sql, "admin_customers_page", admin, null, 100, 0);
    expect(page.rows.find((x: { id: string }) => x.id === m)).toBeUndefined();
    expect(failedWith(await attempt(order(m)), "account_deactivated")).toBe(true);
    expect(failedWith(await attempt(setStatus(m, "reactivate")), "account_deleted")).toBe(true);
    expect(
      failedWith(
        await attempt(rpc(sql, "admin_account_delete", admin, m, "again please", key("del"))),
        "account_deleted",
      ),
    ).toBe(true);

    // The audit row names no one.
    const audit = await val<string>(
      sql`SELECT metadata::text FROM public.audit_log WHERE entity_id = ${m} AND action = 'member_account_deleted'`,
    );
    expect(audit).not.toMatch(/Katlego|0821234567|@test\.local/);
  });

  it("refuses to delete a member with an order in progress, and a staff account", async () => {
    const m = await mkMember(sql);
    await order(m);
    expect(
      failedWith(
        await attempt(rpc(sql, "admin_account_delete", admin, m, "asked in store", key("d"))),
        "open_orders",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(rpc(sql, "admin_account_delete", admin, manager, "asked in store", key("d"))),
        "staff_account",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(rpc(sql, "admin_account_delete", admin, admin, "asked in store", key("d"))),
        "invalid_input",
      ),
    ).toBe(true);
  });

  it("browsers cannot write the account columns or run the functions (mutation guard)", async () => {
    const m = await mkMember(sql);
    await setStatus(m, "deactivate");
    const write = await attempt(
      asUser(sql, m, (tx) => tx`UPDATE public.profiles SET deactivated_at = NULL WHERE id = ${m}`),
    );
    expect(write.ok).toBe(false);
    const run = await attempt(
      asUser(
        sql,
        m,
        (tx) => tx`SELECT public.member_account_set_status(${m}::uuid, 'reactivate', ${key("x")})`,
      ),
    );
    expect(run.ok).toBe(false);
    expect((await state(m)).status).toBe("deactivated");
  });
});
