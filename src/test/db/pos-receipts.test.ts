import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, asAnon, asUser, attempt, connect, mkUser, type Sql } from "./helpers";

describe.skipIf(!DB_URL)("receipt settings and receipt logs (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => void (sql = connect(4)));
  afterAll(async () => void (await sql.end()));

  it("ships one settings row with the business details and VAT off", async () => {
    const rows =
      await sql`SELECT legal_name, registration_number, vat_registered, default_paper FROM public.receipt_settings`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      legal_name: "CANNAPLUG PTY LTD",
      registration_number: "2026/047873/07",
      vat_registered: false,
      default_paper: "80mm",
    });
    expect(
      (
        await attempt(
          sql`INSERT INTO public.receipt_settings (id, trading_name, legal_name, address) VALUES (false, 'x', 'y', 'z')`,
        )
      ).ok,
    ).toBe(false);
  });

  it("VAT cannot be switched on without a valid SA VAT number", async () => {
    await sql
      .begin(async (tx) => {
        expect(
          (await attempt(tx`UPDATE public.receipt_settings SET vat_registered = true`)).ok,
        ).toBe(false);
        throw new Error("rollback");
      })
      .catch(() => undefined);
    await sql
      .begin(async (tx) => {
        expect(
          (
            await attempt(
              tx`UPDATE public.receipt_settings SET vat_registered = true, vat_number = '123'`,
            )
          ).ok,
        ).toBe(false);
        throw new Error("rollback");
      })
      .catch(() => undefined);
    await sql
      .begin(async (tx) => {
        await tx`UPDATE public.receipt_settings SET vat_registered = true, vat_number = '4123456789'`;
        throw new Error("rollback");
      })
      .catch((e) => expect((e as Error).message).toBe("rollback"));
  });

  it("browsers cannot read or write any receipt table", async () => {
    const manager = await mkUser(sql, "manager");
    for (const t of ["receipt_settings", "pos_receipt_meta", "pos_receipt_sends"]) {
      expect(
        (await attempt(asAnon(sql, (tx) => tx.unsafe(`SELECT 1 FROM public.${t}`)))).ok,
        `anon ${t}`,
      ).toBe(false);
      expect(
        (await attempt(asUser(sql, manager, (tx) => tx.unsafe(`SELECT 1 FROM public.${t}`)))).ok,
        `manager ${t}`,
      ).toBe(false);
    }
  });
});
