import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, attempt, connect, uid, type Sql } from "./helpers";

describe.skipIf(!DB_URL)("product subcategories (real PostgreSQL)", () => {
  let sql: Sql;
  const insert = (subcategory: string | null) => {
    const id = uid();
    return sql`INSERT INTO public.products (id, slug, name, category, price_rand, subcategory, is_active, sell_online)
               VALUES (${id}, ${`sub-${id}`}, ${`Sub test ${id.slice(0, 6)}`}, 'Flower', 50, ${subcategory}, false, false) RETURNING id`;
  };

  beforeAll(() => {
    sql = connect(4);
  });
  afterAll(async () => {
    await sql.end();
  });

  it("accepts no subcategory and a tidy one", async () => {
    expect((await attempt(insert(null))).ok).toBe(true);
    expect((await attempt(insert("Top Shelf"))).ok).toBe(true);
    expect((await attempt(insert("Greendoor 2-in-1"))).ok).toBe(true);
  });

  it("refuses leading or trailing spaces, an empty value and one over 60 characters", async () => {
    for (const bad of [" Top Shelf", "Top Shelf ", "", "x".repeat(61)])
      expect((await attempt(insert(bad))).ok, JSON.stringify(bad)).toBe(false);
    expect((await attempt(insert("x".repeat(60)))).ok).toBe(true);
  });

  it("the shop filter has its index", async () => {
    const rows =
      await sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'products_shop_idx'`;
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!["indexdef"])).toMatch(/\(category, subcategory\)/);
  });

  it("mutation check: without the check an untidy subcategory would be accepted", async () => {
    const rolledBack = Symbol("rollback");
    let accepted = false;
    await sql
      .begin(async (tx) => {
        await tx`ALTER TABLE public.products DROP CONSTRAINT products_subcategory_chk`;
        const id = uid();
        accepted = (
          await attempt(
            tx`INSERT INTO public.products (id, slug, name, category, price_rand, subcategory) VALUES (${id}, ${`sub-${id}`}, 'Mutation', 'Flower', 1, ' Top Shelf ')`,
          )
        ).ok;
        throw rolledBack;
      })
      .catch((e) => {
        if (e !== rolledBack) throw e;
      });
    expect(accepted).toBe(true);
    expect((await attempt(insert(" Top Shelf "))).ok).toBe(false);
  });
});
