import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asUser,
  attempt,
  connect,
  failedWith,
  key,
  mkUser,
  rpc,
  uid,
  val,
  verifyDirect,
  type Sql,
} from "./helpers";

/** Generated usernames (which are also referral codes) and the one-time change — real PostgreSQL. */
describe.skipIf(!DB_URL)("generated usernames (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => {
    sql = connect(10);
  });
  afterAll(async () => {
    await sql.end();
  });

  // A short unique surname keeps the generated base unique to each test.
  const tag = () =>
    uid()
      .replace(/[^a-z]/g, "")
      .slice(0, 6) || "qzxwvu";
  const person = async (first: string, last: string, verified: boolean, role = "customer") => {
    const id = await mkUser(sql, role as never);
    await sql`UPDATE public.profiles SET first_name = ${first}, last_name = ${last},
                full_name = ${`${first} ${last}`} WHERE id = ${id}`;
    if (verified) await verifyDirect(sql, id);
    return id;
  };
  const ensure = (id: string) => rpc(sql, "member_ensure_username", id);
  const setName = (id: string, name: string) =>
    rpc(sql, "member_set_username", id, name, key("auto"));
  const row = async (id: string) =>
    (await sql`SELECT username, username_auto FROM public.profiles WHERE id = ${id}`)[0] as {
      username: string | null;
      username_auto: boolean;
    };

  it("gives a verified member a name from their first name and surname initial", async () => {
    const first = `Zq${tag()}`;
    const id = await person(first, "Nkosi", true);
    const out = await ensure(id);
    expect(out.username).toBe(`${first.toLowerCase()}n`.slice(0, 13));
    expect(await row(id)).toEqual({ username: out.username, username_auto: true });
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.audit_log WHERE entity_id = ${id} AND action = 'member_username_generated'`,
      ),
    ).toBe(1);
    // asking again changes nothing
    expect((await ensure(id)).username).toBe(out.username);
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.audit_log WHERE entity_id = ${id} AND action = 'member_username_generated'`,
      ),
    ).toBe(1);
  });

  it("adds digits when the generated name is taken, and never reuses a reserved word", async () => {
    const first = `Yq${tag()}`;
    const a = await person(first, "Mbeki", true);
    const b = await person(first, "Mbeki", true);
    const na = (await ensure(a)).username as string;
    const nb = (await ensure(b)).username as string;
    expect(nb).not.toBe(na);
    expect(nb.startsWith(na.slice(0, 12))).toBe(true);
    expect(nb).toMatch(/^[a-z0-9_]{3,20}$/);
    // a name that is too short or empty falls back to "member…", and "admin" is never handed out
    const odd = await person("Ad", "Min", true);
    const no = (await ensure(odd)).username as string;
    expect(no).not.toBe("admin");
    expect(no).toMatch(/^[a-z0-9_]{3,20}$/);
  });

  it("does not give an unverified member one, but does give staff one", async () => {
    const unverified = await person("Una", `Ver${tag()}`, false);
    expect((await ensure(unverified)).username).toBeNull();
    expect((await row(unverified)).username).toBeNull();
    const staff = await person("Sta", `Ff${tag()}`, false, "budtender");
    expect((await ensure(staff)).username).toMatch(/^sta/);
    // once they verify, the next call gives them one
    await verifyDirect(sql, unverified);
    expect((await ensure(unverified)).username).toMatch(/^una/);
  });

  it("a generated username can be changed once; then it is final", async () => {
    const id = await person("Chg", `Once${tag()}`, true);
    const generated = (await ensure(id)).username as string;
    expect(await rpc(sql, "member_rewards_summary", id)).toMatchObject({
      username: generated,
      username_auto: true,
      can_change: true,
    });
    const mine = `mine_${tag()}`;
    await setName(id, mine);
    expect(await row(id)).toEqual({ username: mine, username_auto: false });
    expect(failedWith(await attempt(setName(id, `${mine}2`)), "username_already_set")).toBe(true);
    expect(await rpc(sql, "member_rewards_summary", id)).toMatchObject({
      username: mine,
      can_change: false,
    });
    // the freed generated name can be used by someone else
    const other = await mkUser(sql, "customer");
    await setName(other, generated);
    expect((await row(other)).username).toBe(generated);
  });

  it("keeping the generated name also makes it final", async () => {
    const id = await person("Kee", `Pit${tag()}`, true);
    const generated = (await ensure(id)).username as string;
    await setName(id, generated.toUpperCase());
    expect(await row(id)).toEqual({ username: generated, username_auto: false });
    expect(failedWith(await attempt(setName(id, `x${tag()}`)), "username_already_set")).toBe(true);
  });

  it("a replacement still has to be free, valid and not reserved, and a refusal leaves the generated name", async () => {
    const id = await person("Val", `Id${tag()}`, true);
    const generated = (await ensure(id)).username as string;
    const taker = await mkUser(sql, "customer");
    const taken = `tk_${tag()}`;
    await setName(taker, taken);
    expect(failedWith(await attempt(setName(id, taken)), "username_taken")).toBe(true);
    expect(failedWith(await attempt(setName(id, "Admin")), "username_reserved")).toBe(true);
    expect(failedWith(await attempt(setName(id, "no")), "username_invalid")).toBe(true);
    expect(await row(id)).toEqual({ username: generated, username_auto: true });
  });

  it("a member who chose their own username cannot change it", async () => {
    const id = await person("Own", `Pick${tag()}`, true);
    await setName(id, `own_${tag()}`);
    expect(failedWith(await attempt(setName(id, `new_${tag()}`)), "username_already_set")).toBe(
      true,
    );
    // and ensure leaves it alone
    expect(await row(id)).toMatchObject({ username_auto: false });
    const before = (await row(id)).username;
    expect((await ensure(id)).username).toBe(before);
  });

  it("browsers cannot read the helpers or write the flag", async () => {
    const id = await person("Brw", `Ser${tag()}`, true);
    expect(
      (
        await attempt(
          asUser(
            sql,
            id,
            async (tx) => tx`UPDATE public.profiles SET username_auto = true WHERE id = ${id}`,
          ),
        )
      ).ok,
    ).toBe(false);
    for (const fn of [
      "member_ensure_username(uuid)",
      "_username_assign(uuid)",
      "_username_generate(uuid)",
    ]) {
      expect(
        (
          await attempt(
            asUser(sql, id, async (tx) =>
              tx.unsafe(`SELECT public.${fn.replace("uuid", `'${id}'::uuid`)}`),
            ),
          )
        ).ok,
      ).toBe(false);
    }
  });

  it("mutation check: without the 'generated names only' rule a chosen username could be changed again", async () => {
    const id = await person("Mut", `Ate${tag()}`, true);
    await setName(id, `fixed_${tag()}`);
    const rolledBack = new Error("rollback");
    const out = await sql
      .begin(async (tx) => {
        const [fnRow] =
          await tx`SELECT pg_get_functiondef('public.member_set_username(uuid,text,text)'::regprocedure) AS def`;
        const def = fnRow!["def"];
        const broken = String(def).replace(
          "IF v_current IS NOT NULL AND NOT v_auto THEN",
          "IF false THEN",
        );
        expect(broken).not.toBe(def);
        await tx.unsafe(broken);
        await rpc(tx as unknown as Sql, "member_set_username", id, `again_${tag()}`, key("mut"));
        throw rolledBack;
      })
      .catch((e) => e);
    expect(out).toBe(rolledBack);
    expect(failedWith(await attempt(setName(id, `real_${tag()}`)), "username_already_set")).toBe(
      true,
    );
  });
});
