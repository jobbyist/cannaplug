import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, attempt, connect, failedWith, key, mkUser, rpc, type Sql } from "./helpers";

/** 5 Nov 2026: the ID / passport number is entered at the verification step instead of at sign-up. */
describe.skipIf(!DB_URL)("verification_record_id_number (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => {
    sql = connect(5);
  });
  afterAll(async () => {
    await sql.end();
  });

  const stored = async (u: string) =>
    (await sql`SELECT id_number FROM public.member_signup_details WHERE user_id = ${u}`)[0]?.[
      "id_number"
    ] ?? null;
  const record = (u: string, n: string, dob: string | null = "1990-05-17", k = key("idn")) =>
    rpc(sql, "verification_record_id_number", u, n, dob, k);

  it("cleans and stores a valid SA ID number, and audits without the number", async () => {
    const u = await mkUser(sql, "customer");
    const r = await record(u, "900517 5009-083");
    expect(r).toMatchObject({ stored: true });
    expect(await stored(u)).toBe("9005175009083");
    const audit = await sql`SELECT metadata FROM public.audit_log
                            WHERE action = 'id_number_recorded' AND target_user_id = ${u}`;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!["metadata"])).not.toContain("9005175009083");
    // Nothing identifying is kept in the idempotency table either.
    const idem = await sql`SELECT request_hash, response FROM public.operation_idempotency
                           WHERE scope = 'id_number' AND key LIKE ${u + ":%"}`;
    expect(JSON.stringify(idem)).not.toContain("9005175009083");
  });

  it("refuses a bad checksum, a date-of-birth mismatch and junk", async () => {
    const u = await mkUser(sql, "customer");
    expect(failedWith(await attempt(record(u, "9005175009084")), "invalid_id_number")).toBe(true);
    expect(
      failedWith(await attempt(record(u, "9005175009083", "1991-05-17")), "id_dob_mismatch"),
    ).toBe(true);
    expect(failedWith(await attempt(record(u, "!!")), "invalid_id_number")).toBe(true);
    expect(await stored(u)).toBeNull();
  });

  it("accepts a passport number, keeps the first number on file and never replaces it", async () => {
    const u = await mkUser(sql, "customer");
    await record(u, "a1234567");
    expect(await stored(u)).toBe("A1234567");
    const again = await record(u, "B7654321");
    expect(again).toMatchObject({ stored: false, already_on_file: true });
    expect(await stored(u)).toBe("A1234567");
  });

  it("keeps a number given at sign-up by an older browser", async () => {
    const id = crypto.randomUUID();
    await sql`INSERT INTO auth.users (id, email, raw_user_meta_data)
              VALUES (${id}, ${`old-${id}@test.local`}, ${sql.json({ full_name: "Old Client", id_number: "C1234567" })})`;
    await record(id, "D7654321");
    expect(await stored(id)).toBe("C1234567");
  });

  it("a retry with the same key is answered from the first call", async () => {
    const u = await mkUser(sql, "customer");
    const k = key("idn-retry");
    await record(u, "E1234567", "1990-05-17", k);
    const replay = await record(u, "E1234567", "1990-05-17", k);
    expect(replay).toMatchObject({ stored: true, replayed: true });
  });

  it("only the server can call it", async () => {
    for (const role of ["anon", "authenticated"]) {
      const [g] = await sql`SELECT has_function_privilege(${role},
        'public.verification_record_id_number(uuid,text,date,text)', 'EXECUTE') AS ok`;
      expect(g!["ok"]).toBe(false);
    }
  });

  it("mutation check: without the keep-first rule a member could swap the number staff checked", async () => {
    const u = await mkUser(sql, "customer");
    await record(u, "F1234567");
    class Undo extends Error {}
    await sql
      .begin(async (tx) => {
        const [def] = await tx`SELECT pg_get_functiondef(
          'public.verification_record_id_number(uuid,text,date,text)'::regprocedure) AS d`;
        const broken = String(def!["d"])
          .replace("IF v_existing IS NULL THEN", "IF true THEN")
          .replace("WHERE public.member_signup_details.id_number IS NULL", "");
        expect(broken).not.toBe(def!["d"]);
        await tx.unsafe(broken);
        await tx.unsafe(
          `SELECT public.verification_record_id_number('${u}', 'G7654321', '1990-05-17', '${key("mut")}')`,
        );
        const [row] =
          await tx`SELECT id_number FROM public.member_signup_details WHERE user_id = ${u}`;
        expect(row!["id_number"]).toBe("G7654321"); // the attack works once the rule is gone
        throw new Undo();
      })
      .catch((e) => {
        if (!(e instanceof Undo)) throw e;
      });
    expect(await stored(u)).toBe("F1234567");
  });
});
