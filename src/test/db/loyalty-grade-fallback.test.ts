import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, connect, uid, val, type Sql } from "./helpers";

/**
 * 27 Nov 2026: Purple Champagne (category "Prerolls", no grade in its name) did not appear in the Loyalty tab.
 * The reward rule now ignores category punctuation and reads the grade from Subcategory first, then the name bracket.
 */
describe.skipIf(!DB_URL)(
  "loyalty reward eligibility: category spelling and subcategory grade",
  () => {
    let sql: Sql;
    beforeAll(() => {
      sql = connect(5);
    });
    afterAll(async () => {
      await sql.end();
    });

    async function product(o: {
      name: string;
      category: string;
      subcategory?: string | null;
      active?: boolean;
    }) {
      const id = uid();
      await sql`INSERT INTO public.products (id, slug, name, category, subcategory, price_rand, is_active)
              VALUES (${id}, ${`p-${id}`}, ${o.name}, ${o.category}, ${o.subcategory ?? null}, 100, ${o.active ?? true})`;
      return id;
    }
    const eligible = (code: string, id: string) =>
      val<boolean>(sql`SELECT public._reward_eligible(${code}, ${id}::uuid)`);

    it("covers a 'Prerolls' product graded through its Subcategory, with no bracket in the name (Purple Champagne)", async () => {
      const id = await product({
        name: "Purple Champagne",
        category: "Prerolls",
        subcategory: "Entry Indoor",
      });
      expect(await eligible("indoor_free", id)).toBe(true);
      expect(await eligible("greenhouse_free", id)).toBe(false);
    });

    it("still covers the original shape: exact category with the grade in brackets", async () => {
      const id = await product({ name: "Blue Gelato (Greenhouse)", category: "Flower" });
      expect(await eligible("greenhouse_free", id)).toBe(true);
      expect(await eligible("indoor_free", id)).toBe(false);
    });

    it("ignores category spelling: 'pre rolls', 'Pre-Rolls' and 'Prerolls' are one category", async () => {
      for (const category of ["pre rolls", "Pre-Rolls", "Prerolls"]) {
        const id = await product({ name: `Kings Juice (Entry Indoor)`, category });
        expect(await eligible("indoor_free", id)).toBe(true);
      }
    });

    it("the Subcategory wins over the bracket when staff set one", async () => {
      const id = await product({
        name: "Sour OG (Greenhouse)",
        category: "Pre-rolls",
        subcategory: "Top Shelf",
      });
      expect(await eligible("greenhouse_free", id)).toBe(false);
    });

    it("never covers the wrong thing: other categories, ungraded, other grades, inactive, unknown reward", async () => {
      expect(
        await eligible(
          "greenhouse_free",
          await product({ name: "Gummies (Greenhouse)", category: "Edibles" }),
        ),
      ).toBe(false);
      expect(
        await eligible(
          "greenhouse_free",
          await product({ name: "Moonstick", category: "Pre-rolls" }),
        ),
      ).toBe(false);
      expect(
        await eligible(
          "indoor_free",
          await product({ name: "Zaza (Top Shelf)", category: "Flower" }),
        ),
      ).toBe(false);
      expect(
        await eligible(
          "greenhouse_free",
          await product({ name: "Orange Cookies (Greenhouse)", category: "Flower", active: false }),
        ),
      ).toBe(false);
      const ok = await product({ name: "Orange Cookies (Greenhouse)", category: "Flower" });
      expect(await eligible("no_such_reward", ok)).toBe(false);
    });

    it("the function stays service-role only", async () => {
      const pub = await val<boolean>(
        sql`SELECT has_function_privilege('anon', 'public._reward_eligible(text, uuid)', 'EXECUTE')`,
      );
      const auth = await val<boolean>(
        sql`SELECT has_function_privilege('authenticated', 'public._reward_eligible(text, uuid)', 'EXECUTE')`,
      );
      expect(pub).toBe(false);
      expect(auth).toBe(false);
    });
  },
);
