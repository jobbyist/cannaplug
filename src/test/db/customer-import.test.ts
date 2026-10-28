import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, asUser, attempt, connect, key, mkUser, rpc, uid, val, type Sql } from "./helpers";

/**
 * Customer import: provisional ID status, usernames from the file, the sign-up "claim" that spends 3 reserved ID-check
 * credits, the one-time username change and the 20-a-day invitation emails.
 */
describe.skipIf(!DB_URL)("customer import (real PostgreSQL)", () => {
  let sql: Sql;
  let admin: string;
  // Member numbers are unique in the table, and the test database outlives a run.
  let seq = Math.floor(Math.random() * 1_000_000_000);
  beforeAll(async () => {
    sql = connect(10);
    admin = await mkUser(sql, "admin");
  });
  afterAll(async () => {
    await sql.end();
  });

  const row = (over: Record<string, unknown> = {}) => {
    const n = ++seq;
    const id = uid().slice(0, 8);
    return {
      member_number: n,
      first_name: "Thandi",
      last_name: "Mokoena",
      email: `Thandi-${id}@Test.Local`,
      phone: "(061) 418-7540",
      username: `thandi.m${id}`,
      age: 30,
      ...over,
    };
  };
  const importRows = (rows: unknown[], actor = admin) =>
    rpc(
      sql,
      "import_customers",
      actor,
      `batch-${uid().slice(0, 8)}`,
      "a".repeat(64),
      rows,
      key("imp"),
    );
  const importOne = async (over: Record<string, unknown> = {}) => {
    const r = row(over);
    const out = await importRows([r]);
    expect(out.imported).toBe(1);
    const id = await val<string>(
      sql`SELECT id FROM auth.users WHERE email = ${r.email.toLowerCase()}`,
    );
    return { id, r };
  };
  const reserve = async () =>
    (await sql`SELECT * FROM public._id_credit_balance()`)[0] as unknown as {
      available: number;
      reserved: number;
    };
  const claim = (id: string, meta: Record<string, unknown> = {}) =>
    sql`UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data || ${sql.json({
      id_number: "9001015009087",
      first_name: "Thandi",
      last_name: "Mokoena",
      ...meta,
    } as never)} WHERE id = ${id}`;
  const submitId = (member: string) =>
    rpc(
      sql,
      "verification_submit",
      member,
      "sa_id",
      `${member}/${uid()}.jpg`,
      "1990-01-01",
      null,
      key("id"),
    );

  it("only an admin can import", async () => {
    for (const role of ["customer", "budtender", "manager"] as const) {
      const r = await attempt(importRows([row()], await mkUser(sql, role)));
      expect(r.ok).toBe(false);
    }
  });

  it("creates a provisional member with the file's username, an unconfirmed account and the customer role", async () => {
    const { id, r } = await importOne();
    const u = (await sql`SELECT email, raw_app_meta_data FROM auth.users WHERE id = ${id}`)[0]!;
    expect(u["email"]).toBe(r.email.toLowerCase());
    expect(u["raw_app_meta_data"].source).toBe("customer_import");
    const p = (
      await sql`SELECT username, first_name, last_name, full_name, phone FROM public.profiles WHERE id = ${id}`
    )[0]!;
    expect(p["username"]).toBe(r.username); // dots are allowed
    expect(p["full_name"]).toBe("Thandi Mokoena");
    expect(
      await val(sql`SELECT status FROM public.customer_verification WHERE user_id = ${id}`),
    ).toBe("provisional");
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.user_roles WHERE user_id = ${id} AND role = 'customer'`,
        ),
      ),
    ).toBe(1);
    expect(
      Number(await val(sql`SELECT count(*) FROM public.imported_customers WHERE user_id = ${id}`)),
    ).toBe(1);
  });

  it("refuses minors, unknown ages, existing emails, taken or reserved usernames and bad data, row by row", async () => {
    const taken = await importOne();
    const minor = row({ age: 16 });
    const noAge = row({ age: null });
    const dupEmail = row({ email: taken.r.email });
    const dupUser = row({ username: taken.r.username });
    const reserved = row({ username: "admin" });
    const badEmail = row({ email: "not an email" });
    const good = row();
    const out = await importRows([minor, noAge, dupEmail, dupUser, reserved, badEmail, good]);
    expect(out.imported).toBe(1);
    const why = Object.fromEntries(out.skipped.map((s: any) => [s.member_number, s.reason]));
    expect(why[minor.member_number]).toBe("underage_or_unknown_age");
    expect(why[noAge.member_number]).toBe("underage_or_unknown_age");
    expect(why[dupEmail.member_number]).toBe("email_exists");
    expect(why[dupUser.member_number]).toBe("username_taken");
    expect(why[reserved.member_number]).toBe("invalid_username");
    expect(why[badEmail.member_number]).toBe("invalid_email");
    expect(JSON.stringify(out)).not.toMatch(/@/); // no emails or names in the result
    expect(
      Number(
        await val(sql`SELECT count(*) FROM auth.users WHERE email = ${minor.email.toLowerCase()}`),
      ),
    ).toBe(0);
  });

  it("is idempotent per key, and a batch cannot be imported twice", async () => {
    const rows = [row()];
    const k = key("imp");
    const batch = `batch-${uid().slice(0, 8)}`;
    const a = await rpc(sql, "import_customers", admin, batch, "b".repeat(64), rows, k);
    const b = await rpc(sql, "import_customers", admin, batch, "b".repeat(64), rows, k);
    expect(b.replayed).toBe(true);
    expect(b.imported).toBe(a.imported);
    const again = await attempt(
      rpc(sql, "import_customers", admin, batch, "b".repeat(64), rows, key("imp")),
    );
    expect(again.ok === false && again.message).toMatch(/^import_already_done/);
  });

  it("a provisional member cannot order online but can be found at the till with their status", async () => {
    const { id, r } = await importOne();
    const gate = await attempt(sql`SELECT public._require_verified_member(${id})`);
    expect(gate.ok === false && gate.message).toMatch(/^verification_provisional/);
    const hits = await rpc(sql, "pos_customer_search", admin, r.username, 5);
    expect(hits.find((h: any) => h.id === id)?.id_status).toBe("provisional");
  });

  it("sign-up with the ID number claims the account and spends 3 reserved credits, with no photo", async () => {
    const { id } = await importOne();
    const before = await reserve();
    await claim(id, { first_name: "Thandi-Lee" });
    const after = await reserve();
    expect(after.reserved).toBe(before.reserved - 3);
    expect(after.available).toBe(before.available);
    expect(
      await val(sql`SELECT id_number FROM public.member_signup_details WHERE user_id = ${id}`),
    ).toBe("9001015009087");
    const meta = await val<any>(sql`SELECT raw_user_meta_data FROM auth.users WHERE id = ${id}`);
    expect(meta.id_number).toBeUndefined();
    expect(await val(sql`SELECT first_name FROM public.profiles WHERE id = ${id}`)).toBe(
      "Thandi-Lee",
    );
    expect(
      await val(
        sql`SELECT claimed_at IS NOT NULL FROM public.imported_customers WHERE user_id = ${id}`,
      ),
    ).toBe(true);
    // Still provisional: they have not uploaded anything.
    expect(
      await val(sql`SELECT status FROM public.customer_verification WHERE user_id = ${id}`),
    ).toBe("provisional");
    // Charged once: another update and the later ID submission cost nothing more.
    await claim(id);
    await submitId(id);
    const last = await reserve();
    expect(last.reserved).toBe(after.reserved);
    expect(
      await val(
        sql`SELECT count(*) FROM public.id_credit_ledger WHERE kind = 'charge' AND member_user_id = ${id}`,
      ),
    ).toBe("1");
    expect(
      await val(sql`SELECT status FROM public.customer_verification WHERE user_id = ${id}`),
    ).toBe("pending");
  });

  it("an ordinary account cannot trigger an import claim, even by claiming to be imported in its own metadata", async () => {
    const member = await mkUser(sql, "customer");
    await sql`UPDATE auth.users SET raw_user_meta_data = ${sql.json({ source: "customer_import", id_number: "9001015009087" } as never)} WHERE id = ${member}`;
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.id_credit_ledger WHERE member_user_id = ${member}`,
        ),
      ),
    ).toBe(0);
    expect(
      Number(
        await val(sql`SELECT count(*) FROM public.member_signup_details WHERE user_id = ${member}`),
      ),
    ).toBe(0);
  });

  it("the sign-up form accepts an imported member's own username with their own email, and no one else's", async () => {
    const { id, r } = await importOne();
    expect(await rpc(sql, "username_check_signup", r.email, r.username)).toBe("ok");
    expect(await rpc(sql, "username_check_signup", "someone@else.local", r.username)).toBe(
      "invalid",
    ); // dots are not for new usernames
    const plain = await importOne({ username: `plain_${uid().slice(0, 6)}` });
    expect(await rpc(sql, "username_check_signup", "someone@else.local", plain.r.username)).toBe(
      "taken",
    );
    await claim(id);
    expect(await rpc(sql, "username_check_signup", r.email, r.username)).toBe("invalid");
  });

  it("an imported member may change the username once, and only after submitting their ID", async () => {
    const { id } = await importOne();
    const tag = uid().slice(0, 6);
    const set = (u: string) => rpc(sql, "member_set_username", id, `${u}${tag}`, key("u"));
    expect((await attempt(set("fresh_name1"))).ok).toBe(false); // not signed up yet: unchanged rule
    await claim(id);
    expect(await rpc(sql, "member_username_change_state", id)).toBe("needs_id");
    const early = await attempt(set("fresh_name1"));
    expect(early.ok === false && early.message).toMatch(/^username_edit_needs_id/);
    await submitId(id);
    expect(await rpc(sql, "member_username_change_state", id)).toBe("available");
    expect((await set("fresh_name1")).username).toBe(`fresh_name1${tag}`);
    expect(await val(sql`SELECT username FROM public.profiles WHERE id = ${id}`)).toBe(
      `fresh_name1${tag}`,
    );
    expect(await rpc(sql, "member_username_change_state", id)).toBe("used");
    const second = await attempt(set("fresh_name2"));
    expect(second.ok === false && second.message).toMatch(/^username_already_set/);
  });

  it("other members still cannot change a username, and an imported member cannot take a dotted one", async () => {
    const member = await mkUser(sql, "customer");
    await rpc(sql, "member_set_username", member, `first_${uid().slice(0, 6)}`, key("u"));
    const again = await attempt(
      rpc(sql, "member_set_username", member, `other_${uid().slice(0, 6)}`, key("u")),
    );
    expect(again.ok === false && again.message).toMatch(/^username_already_set/);
    const { id } = await importOne();
    await claim(id);
    await submitId(id);
    const dotted = await attempt(rpc(sql, "member_set_username", id, "has.dot", key("u")));
    expect(dotted.ok === false && dotted.message).toMatch(/^username_invalid/);
    // A refused change does not use up the one change.
    expect(await rpc(sql, "member_username_change_state", id)).toBe("available");
  });

  it("queues the invitation for 20 members a day, never more, skipping held and signed-up members", async () => {
    await sql`UPDATE public.imported_customers SET invited_at = now() - interval '5 days' WHERE invited_at IS NULL`;
    const rows = Array.from({ length: 47 }, (_, i) =>
      row(i === 0 ? { hold: "email looked mistyped" } : {}),
    );
    const out = await importRows(rows);
    expect(out.imported).toBe(47);
    const signedUp = await val<string>(
      sql`SELECT id FROM auth.users WHERE email = ${rows[1]!.email.toLowerCase()}`,
    );
    await claim(signedUp);

    // A day no earlier run used (the test database outlives a run).
    const day1 = new Date(Date.UTC(2040, 0, 1, 6) + Math.floor(Math.random() * 20000) * 86400_000);
    const a = await rpc(sql, "import_invites_run", day1.toISOString(), 20);
    expect(a.queued).toBe(20);
    const again = await rpc(
      sql,
      "import_invites_run",
      new Date(day1.getTime() + 3600_000).toISOString(),
      20,
    );
    expect(again.queued).toBe(0);
    const bigLimit = await rpc(
      sql,
      "import_invites_run",
      new Date(day1.getTime() + 7200_000).toISOString(),
      500,
    );
    expect(bigLimit.queued).toBe(0); // the daily cap of 20 holds whatever limit is asked for
    const b = await rpc(
      sql,
      "import_invites_run",
      new Date(day1.getTime() + 86400_000).toISOString(),
      20,
    );
    expect(b.queued).toBe(20);
    const c = await rpc(
      sql,
      "import_invites_run",
      new Date(day1.getTime() + 2 * 86400_000).toISOString(),
      20,
    );
    expect(c.queued).toBe(5); // 47 - 1 held - 1 signed up = 45 to invite: 20 + 20 + 5
  });

  it("the invitation email is addressed to the member, carries only a name and username, and is deduplicated", async () => {
    const { id, r } = await importOne({ first_name: "Palesa" });
    await sql`UPDATE public.imported_customers SET invited_at = NULL WHERE user_id = ${id}`;
    await sql`UPDATE public.imported_customers SET invited_at = now() - interval '9 days' WHERE user_id <> ${id} AND invited_at IS NULL`;
    await rpc(
      sql,
      "import_invites_run",
      new Date(
        Date.UTC(2070, 0, 1, 6) + Math.floor(Math.random() * 20000) * 86400_000 * 2,
      ).toISOString(),
      20,
    );
    const n = (
      await sql`SELECT recipient, category, template, data FROM public.notification_events WHERE recipient_user_id = ${id}`
    )[0]!;
    expect(n["template"]).toBe("member_import_invite");
    expect(n["category"]).toBe("transactional");
    expect(n["recipient"]).toBe(r.email.toLowerCase());
    expect(Object.keys(n["data"]).sort()).toEqual(["first_name", "username"]);
    await sql`UPDATE public.imported_customers SET invited_at = NULL WHERE user_id = ${id}`;
    await rpc(
      sql,
      "import_invites_run",
      new Date(
        Date.UTC(2200, 0, 1, 6) + Math.floor(Math.random() * 20000) * 86400_000,
      ).toISOString(),
      20,
    );
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.notification_events WHERE recipient_user_id = ${id}`,
        ),
      ),
    ).toBe(1);
    expect(await rpc(sql, "_email_tier", "member_import_invite")).toBe(2);
  });

  it("browser roles can read or run nothing here", async () => {
    const member = await mkUser(sql, "customer");
    for (const t of ["customer_imports", "imported_customers"]) {
      const r = await attempt(asUser(sql, member, (tx) => tx.unsafe(`SELECT * FROM public.${t}`)));
      expect(r.ok).toBe(false);
    }
    for (const f of [
      "public.import_customers(uuid,text,text,jsonb,text)",
      "public.import_invites_run(timestamptz,integer)",
      "public.username_check_signup(text,text)",
      "public.member_username_change_state(uuid)",
      "public._import_claim()",
    ]) {
      const [x] = await sql.unsafe(
        `SELECT has_function_privilege('authenticated', '${f}', 'execute') a, has_function_privilege('anon', '${f}', 'execute') b`,
      );
      expect([f, x!["a"], x!["b"]]).toEqual([f, false, false]);
    }
  });
});
