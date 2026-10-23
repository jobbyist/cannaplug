import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  asUser,
  attempt,
  connect,
  mkProduct,
  mkUser,
  uid,
  type Sql,
} from "./helpers";

describe.skipIf(!DB_URL)("product SKU, barcode, cost and image (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => void (sql = connect(10)));
  afterAll(async () => void (await sql.end()));

  it("SKU is unique case-insensitively and barcode is unique; both optional", async () => {
    const sku = `T-${uid().slice(0, 8)}`;
    const a = await mkProduct(sql);
    const b = await mkProduct(sql);
    await sql`UPDATE public.products SET sku = ${sku} WHERE id = ${a}`;
    expect(
      (await attempt(sql`UPDATE public.products SET sku = ${sku.toLowerCase()} WHERE id = ${b}`))
        .ok,
    ).toBe(false);
    const code = `600${uid().replace(/-/g, "").slice(0, 10)}`;
    await sql`UPDATE public.products SET barcode = ${code} WHERE id = ${a}`;
    expect(
      (await attempt(sql`UPDATE public.products SET barcode = ${code} WHERE id = ${b}`)).ok,
    ).toBe(false);
    // NULLs never collide
    const c = await mkProduct(sql);
    expect(
      (
        await attempt(
          sql`UPDATE public.products SET sku = NULL, barcode = NULL WHERE id IN (${b}, ${c})`,
        )
      ).ok,
    ).toBe(true);
  });

  it("rejects malformed values", async () => {
    const p = await mkProduct(sql);
    for (const bad of [
      sql`UPDATE public.products SET sku = ' padded ' WHERE id = ${p}`,
      sql`UPDATE public.products SET barcode = 'has space' WHERE id = ${p}`,
      sql`UPDATE public.products SET cost_rand = -1 WHERE id = ${p}`,
      sql`UPDATE public.products SET image_path = '../etc/passwd' WHERE id = ${p}`,
      sql`UPDATE public.products SET image_path = ${`products/${p}/${uid()}.svg`} WHERE id = ${p}`,
    ])
      expect((await attempt(bad)).ok).toBe(false);
    expect(
      (
        await attempt(
          sql`UPDATE public.products SET image_path = ${`products/${p}/${uid()}.webp`}, cost_rand = 12.5 WHERE id = ${p}`,
        )
      ).ok,
    ).toBe(true);
  });

  it("cost_rand is never readable by anon, customers or staff browsers; public columns are", async () => {
    const p = await mkProduct(sql);
    await sql`UPDATE public.products SET cost_rand = 21 WHERE id = ${p}`;
    const anonCost = await attempt(
      asAnon(sql, (tx) => tx`SELECT cost_rand FROM public.products WHERE id = ${p}`),
    );
    expect(anonCost.ok).toBe(false);
    const anonStar = await attempt(
      asAnon(sql, (tx) => tx`SELECT * FROM public.products WHERE id = ${p}`),
    );
    expect(anonStar.ok).toBe(false);
    const anonPublic = await asAnon(
      sql,
      (tx) => tx`SELECT id, name, price_rand, sku, image_path FROM public.products WHERE id = ${p}`,
    );
    expect(anonPublic).toHaveLength(1);
    for (const role of ["customer", "manager"] as const) {
      const u = await mkUser(sql, role);
      const r = await attempt(
        asUser(sql, u, (tx) => tx`SELECT cost_rand FROM public.products WHERE id = ${p}`),
      );
      expect(r.ok, `${role} must not read cost_rand from a browser`).toBe(false);
    }
  });
});
