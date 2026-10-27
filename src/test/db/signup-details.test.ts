import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, connect, uid, type Sql } from "./helpers";

describe.skipIf(!DB_URL)("sign-up details (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => {
    sql = connect(5);
  });
  afterAll(async () => {
    await sql.end();
  });

  const signUp = async (meta: Record<string, string>) => {
    const id = crypto.randomUUID();
    await sql`INSERT INTO auth.users (id, email, raw_user_meta_data)
              VALUES (${id}, ${`su-${uid().slice(0, 8)}@test.local`}, ${sql.json(meta)})`;
    return id;
  };

  it("stores names, phone, ID and referral, and scrubs the ID from user metadata", async () => {
    const id = await signUp({
      full_name: "Rae Hearsal",
      first_name: "Rae",
      last_name: "Hearsal",
      phone: "0821234567",
      date_of_birth: "1990-01-01",
      id_number: "ab 123456",
      referral_code: "friend1",
    });
    const [p] =
      await sql`SELECT first_name, last_name, phone FROM public.profiles WHERE id = ${id}`;
    expect(p).toMatchObject({ first_name: "Rae", last_name: "Hearsal", phone: "0821234567" });
    const [d] =
      await sql`SELECT id_number, referral_code FROM public.member_signup_details WHERE user_id = ${id}`;
    expect(d).toEqual({ id_number: "AB123456", referral_code: "FRIEND1" });
    // Mutation check: if the scrub were removed, the ID number would stay in the session-visible metadata.
    const [u] = await sql`SELECT raw_user_meta_data AS m FROM auth.users WHERE id = ${id}`;
    expect(u!["m"]).not.toHaveProperty("id_number");
    expect(u!["m"]).not.toHaveProperty("referral_code");
    expect(u!["m"]).toHaveProperty("full_name", "Rae Hearsal");
  });

  it("never blocks an account created without details, and ignores malformed values", async () => {
    const plain = await signUp({ full_name: "Staff Person" });
    const [row] = await sql`SELECT 1 AS n FROM public.profiles WHERE id = ${plain}`;
    expect(row).toBeTruthy();
    const none = await sql`SELECT 1 FROM public.member_signup_details WHERE user_id = ${plain}`;
    expect(none).toHaveLength(0);
    const bad = await signUp({ full_name: "Bad Id", id_number: "!!", referral_code: "x" });
    const stored = await sql`SELECT 1 FROM public.member_signup_details WHERE user_id = ${bad}`;
    expect(stored).toHaveLength(0);
  });

  it("is unreadable by browser roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      const [g] =
        await sql`SELECT has_table_privilege(${role}, 'public.member_signup_details', 'SELECT') AS ok`;
      expect(g!["ok"]).toBe(false);
    }
  });
});
