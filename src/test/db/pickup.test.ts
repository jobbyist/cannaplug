import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  attempt,
  connect,
  failedWith,
  key,
  mkMember,
  mkProduct,
  mkUser,
  payOrder,
  receive,
  rpc,
  val,
  type Sql,
} from "./helpers";

describe.skipIf(!DB_URL)("in-store pickup (real PostgreSQL)", () => {
  let sql: Sql;
  let staff: string;
  beforeAll(async () => {
    sql = connect(10);
    staff = await mkUser(sql, "budtender");
  });
  afterAll(async () => {
    await sql.end();
  });

  const basket = async () => {
    const product = await mkProduct(sql, 150);
    await receive(sql, await mkUser(sql, "manager"), product, 10);
    return [{ product_id: product, quantity: 2 }];
  };
  const place = (
    user: string,
    items: unknown,
    method: string,
    address: string | null,
    total: number,
  ) =>
    rpc(
      sql,
      "checkout_place_order",
      user,
      items,
      "Pick Up",
      "+27 82 000 0000",
      method,
      address,
      "eft",
      total,
      null,
      key("co"),
    );
  const move = (order: string, to: string) =>
    rpc(sql, "transition_order_status", order, to, staff, null);

  it("is free, needs no saved address and stores the shop address on the order", async () => {
    const items = await basket();
    const q = await rpc(sql, "checkout_quote", items, "collection");
    expect(Number(q.delivery_fee)).toBe(0);
    expect(Number(q.total)).toBe(300);
    const member = await mkMember(sql);
    const o = await place(member, items, "collection", null, 300);
    const row = (
      await sql`SELECT delivery_method, delivery_fee_rand, total_rand, delivery_address FROM public.orders WHERE id = ${o.order_id}`
    )[0]!;
    expect(row["delivery_method"]).toBe("collection");
    expect(Number(row["delivery_fee_rand"])).toBe(0);
    expect(Number(row["total_rand"])).toBe(300);
    expect(row["delivery_address"]).toMatchObject({
      pickup: true,
      line1: "Shop 002, One On Mutual, Pretoria Central",
    });
  });

  it("goes ready -> completed when collected, and can never be sent out for delivery", async () => {
    const member = await mkMember(sql);
    const o = await place(member, await basket(), "collection", null, 300);
    await payOrder(sql, o.order_id);
    await move(o.order_id, "packing");
    await move(o.order_id, "ready");
    const out = await attempt(move(o.order_id, "out_for_delivery"));
    expect(failedWith(out, "pickup_order")).toBe(true);
    await move(o.order_id, "completed");
    expect(await val(sql`SELECT status FROM public.orders WHERE id = ${o.order_id}`)).toBe(
      "completed",
    );
  });

  it("a delivery order still needs an address and cannot skip out-for-delivery", async () => {
    const member = await mkMember(sql);
    const items = await basket();
    expect(
      failedWith(await attempt(place(member, items, "standard", null, 380)), "address_not_found"),
    ).toBe(true);
    const address = (
      await rpc(
        sql,
        "member_save_address",
        member,
        null,
        { label: "Home", line1: "1 Main Rd", city: "Pretoria" },
        false,
      )
    ).id;
    const o = await place(member, items, "standard", address, 380);
    await payOrder(sql, o.order_id);
    await move(o.order_id, "packing");
    await move(o.order_id, "ready");
    expect(
      failedWith(await attempt(move(o.order_id, "completed")), "invalid order status transition"),
    ).toBe(true);
  });
});
