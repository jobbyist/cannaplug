import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, asUser, attempt, connect, key, mkUser, rpc, uid, val, type Sql } from "./helpers";

/**
 * Customer import: members are staged (no account), they sign up as new members with the email on file and are then
 * linked: provisional ID status, the username from the file, 3 reserved ID-check credits when they give an ID number,
 * the one-time username change, and the 20-a-day invitation emails.
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
      phone: "061 418 7540",
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
  const stage = async (over: Record<string, unknown> = {}) => {
    const r = row(over);
    const out = await importRows([r]);
    expect(out.imported).toBe(1);
    return r;
  };
  const reserve = async () =>
    (await sql`SELECT * FROM public._id_credit_balance()`)[0] as unknown as {
      available: number;
      reserved: number;
    };
  /** Sign-up exactly as Supabase Auth does it: a new auth.users row carrying the form's metadata. */
  const signUp = async (email: string, meta: Record<string, unknown> = {}) => {
    const id = uid();
    await sql`INSERT INTO auth.users (id, email, raw_user_meta_data)
              VALUES (${id}, ${email}, ${sql.json({
                id_number: "9001015009087",
                first_name: "Thandi",
                last_name: "Mokoena",
                ...meta,
              } as never)})`;
    return id;
  };
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

  it("stages members with the file's dotted username and creates no account", async () => {
    const r = await stage();
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM auth.users WHERE lower(email) = ${r.email.toLowerCase()}`,
        ),
      ),
    ).toBe(0);
    const s = (
      await sql`SELECT email, username, first_name, claimed_at, user_id FROM public.imported_customers WHERE member_number = ${r.member_number}`
    )[0]!;
    expect(s["email"]).toBe(r.email.toLowerCase());
    expect(s["username"]).toBe(r.username);
    expect(s["claimed_at"]).toBeNull();
    expect(s["user_id"]).toBeNull();
  });

  it("refuses minors, unknown ages, existing emails, taken or reserved usernames and bad data, row by row", async () => {
    const taken = await stage();
    const member = await mkUser(sql, "customer");
    const existing = (await sql`SELECT email FROM auth.users WHERE id = ${member}`)[0]![
      "email"
    ] as string;
    const minor = row({ age: 16 });
    const noAge = row({ age: null });
    const dupEmail = row({ email: taken.email });
    const accountEmail = row({ email: existing });
    const dupUser = row({ username: taken.username });
    const reserved = row({ username: "admin" });
    const badEmail = row({ email: "not an email" });
    const good = row();
    const out = await importRows([
      minor,
      noAge,
      dupEmail,
      accountEmail,
      dupUser,
      reserved,
      badEmail,
      good,
    ]);
    expect(out.imported).toBe(1);
    const why = Object.fromEntries(out.skipped.map((s: any) => [s.member_number, s.reason]));
    expect(why[minor.member_number]).toBe("underage_or_unknown_age");
    expect(why[noAge.member_number]).toBe("underage_or_unknown_age");
    expect(why[dupEmail.member_number]).toBe("email_exists");
    expect(why[accountEmail.member_number]).toBe("email_exists");
    expect(why[dupUser.member_number]).toBe("username_taken");
    expect(why[reserved.member_number]).toBe("invalid_username");
    expect(why[badEmail.member_number]).toBe("invalid_email");
    expect(JSON.stringify(out)).not.toMatch(/@/); // no emails or names in the result
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.imported_customers WHERE member_number = ${minor.member_number}`,
        ),
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

  it("signing up with the email on file links the new account: provisional, the file's username, 3 reserved credits, no photo", async () => {
    const r = await stage();
    const before = await reserve();
    // The form's email may differ in case; the form's own username choice is replaced by the one on file.
    const id = await signUp(r.email, { first_name: "Thandi-Lee" });
    const after = await reserve();
    expect(after.reserved).toBe(before.reserved - 3);
    expect(after.available).toBe(before.available);
    expect(
      await val(sql`SELECT status FROM public.customer_verification WHERE user_id = ${id}`),
    ).toBe("provisional");
    expect(await val(sql`SELECT username FROM public.profiles WHERE id = ${id}`)).toBe(r.username);
    expect(await val(sql`SELECT first_name FROM public.profiles WHERE id = ${id}`)).toBe(
      "Thandi-Lee",
    );
    expect(
      await val(sql`SELECT raw_app_meta_data->>'source' FROM auth.users WHERE id = ${id}`),
    ).toBe("customer_import");
    expect(
      await val(sql`SELECT id_number FROM public.member_signup_details WHERE user_id = ${id}`),
    ).toBe("9001015009087");
    const meta = await val<any>(sql`SELECT raw_user_meta_data FROM auth.users WHERE id = ${id}`);
    expect(meta.id_number).toBeUndefined();
    const s = (
      await sql`SELECT user_id, claimed_at FROM public.imported_customers WHERE member_number = ${r.member_number}`
    )[0]!;
    expect(s["user_id"]).toBe(id);
    expect(s["claimed_at"]).not.toBeNull();
    // Charged once: the later ID submission costs nothing more and moves provisional to pending.
    await submitId(id);
    expect((await reserve()).reserved).toBe(after.reserved);
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.id_credit_ledger WHERE kind = 'charge' AND member_user_id = ${id}`,
        ),
      ),
    ).toBe(1);
    expect(
      await val(sql`SELECT status FROM public.customer_verification WHERE user_id = ${id}`),
    ).toBe("pending");
  });

  it("without an ID number the link still happens, and the credits are taken from the reserve at the first ID submission", async () => {
    const r = await stage();
    const before = await reserve();
    const id = await signUp(r.email, { id_number: "" });
    expect((await reserve()).reserved).toBe(before.reserved);
    expect(
      await val(sql`SELECT status FROM public.customer_verification WHERE user_id = ${id}`),
    ).toBe("provisional");
    await submitId(id);
    const after = await reserve();
    expect(after.reserved).toBe(before.reserved - 3);
    expect(after.available).toBe(before.available);
  });

  it("an email that is not on the list is an ordinary sign-up: not linked, not provisional, not from the reserve", async () => {
    await stage();
    const before = await reserve();
    const id = await signUp(`someone-${uid().slice(0, 8)}@test.local`);
    expect(
      Number(
        await val(sql`SELECT count(*) FROM public.customer_verification WHERE user_id = ${id}`),
      ),
    ).toBe(0);
    expect(
      Number(await val(sql`SELECT count(*) FROM public.imported_customers WHERE user_id = ${id}`)),
    ).toBe(0);
    expect(
      await val(sql`SELECT raw_app_meta_data->>'source' FROM auth.users WHERE id = ${id}`),
    ).toBeNull();
    expect((await reserve()).reserved).toBe(before.reserved);
    // Claiming to be imported in the browser-controlled metadata changes nothing either.
    const other = uid();
    await sql`INSERT INTO auth.users (id, email, raw_user_meta_data)
              VALUES (${other}, ${`fake-${other}@test.local`}, '{"source":"customer_import","id_number":"9001015009087"}')`;
    expect(
      Number(
        await val(sql`SELECT count(*) FROM public.customer_verification WHERE user_id = ${other}`),
      ),
    ).toBe(0);
  });

  it("a provisional member cannot order online but is findable at the till; an unlinked staged member is shown but cannot be attached", async () => {
    const r = await stage();
    const waiting = await rpc(sql, "pos_customer_search", admin, r.username, 5);
    expect(waiting[0]).toMatchObject({ id_status: "provisional", can_attach: false });
    expect(waiting[0].blocked_reason).toMatch(/not signed up/i);
    const id = await signUp(r.email);
    const gate = await attempt(sql`SELECT public._require_verified_member(${id})`);
    expect(gate.ok === false && gate.message).toMatch(/^verification_provisional/);
    const hits = await rpc(sql, "pos_customer_search", admin, r.username, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id, id_status: "provisional", can_attach: true });
  });

  it("the sign-up form accepts an imported member's own username with their own email, and no one else's", async () => {
    const r = await stage();
    expect(await rpc(sql, "username_check_signup", r.email, r.username)).toBe("ok");
    expect(await rpc(sql, "username_check_signup", "someone@else.local", r.username)).toBe(
      "invalid",
    ); // dots are not for new usernames
    const plain = await stage({ username: `plain_${uid().slice(0, 6)}` });
    expect(await rpc(sql, "username_check_signup", "someone@else.local", plain.username)).toBe(
      "taken",
    );
    expect(await rpc(sql, "username_check", plain.username)).toBe("taken"); // reserved for the staged member
    await signUp(r.email);
    expect(await rpc(sql, "username_check_signup", r.email, r.username)).toBe("invalid");
  });

  it("an imported member may change the username once, and only after submitting their ID", async () => {
    const r = await stage();
    const id = await signUp(r.email);
    const tag = uid().slice(0, 6);
    const set = (u: string) => rpc(sql, "member_set_username", id, `${u}${tag}`, key("u"));
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
    const r = await stage();
    const id = await signUp(r.email);
    await submitId(id);
    const dotted = await attempt(rpc(sql, "member_set_username", id, "has.dot", key("u")));
    expect(dotted.ok === false && dotted.message).toMatch(/^username_invalid/);
    // A refused change does not use up the one change.
    expect(await rpc(sql, "member_username_change_state", id)).toBe("available");
  });

  it("a generated username can still be replaced once, then it is final (the generated-username rule is not lost)", async () => {
    const member = await mkUser(sql, "customer");
    const tag = uid().slice(0, 6);
    await sql`UPDATE public.profiles SET username = ${`gen_${tag}`}, username_auto = true WHERE id = ${member}`;
    expect((await rpc(sql, "member_set_username", member, `mine_${tag}`, key("u"))).username).toBe(
      `mine_${tag}`,
    );
    const again = await attempt(rpc(sql, "member_set_username", member, `more_${tag}`, key("u")));
    expect(again.ok === false && again.message).toMatch(/^username_already_set/);
  });

  it("the staged record goes with the account when the account is deleted (POPIA)", async () => {
    // audit_log is append-only here, so a real delete is exercised by the account-deletion job; check the rule itself.
    expect(
      await val(sql`SELECT confdeltype FROM pg_constraint
                    WHERE conrelid = 'public.imported_customers'::regclass AND contype = 'f'
                      AND confrelid = 'auth.users'::regclass`),
    ).toBe("c");
  });

  it("queues the invitation for 20 members a day, never more, skipping held and signed-up members", async () => {
    await sql`UPDATE public.imported_customers SET invited_at = now() - interval '5 days' WHERE invited_at IS NULL`;
    const rows = Array.from({ length: 47 }, (_, i) =>
      row(i === 0 ? { hold: "email needs confirming" } : {}),
    );
    const out = await importRows(rows);
    expect(out.imported).toBe(47);
    await signUp(rows[1]!.email);

    // A day no earlier run used (the test database outlives a run).
    const day1 = new Date(Date.UTC(2040, 0, 1, 6) + Math.floor(Math.random() * 20000) * 86400_000);
    const at = (h: number, d = 0) =>
      new Date(day1.getTime() + h * 3600_000 + d * 86400_000).toISOString();
    expect((await rpc(sql, "import_invites_run", at(0), 20)).queued).toBe(20);
    expect((await rpc(sql, "import_invites_run", at(1), 20)).queued).toBe(0);
    expect((await rpc(sql, "import_invites_run", at(2), 500)).queued).toBe(0); // the cap holds whatever limit is asked for
    expect((await rpc(sql, "import_invites_run", at(0, 1), 20)).queued).toBe(20);
    expect((await rpc(sql, "import_invites_run", at(0, 2), 20)).queued).toBe(5); // 47 - 1 held - 1 signed up = 45: 20 + 20 + 5
    expect((await rpc(sql, "import_invites_run", at(0, 3), 20)).queued).toBe(0);
  });

  it("the invitation email is addressed to the member, carries only a name and username, and is deduplicated", async () => {
    const r = await stage({ first_name: "Palesa" });
    await sql`UPDATE public.imported_customers SET invited_at = now() - interval '9 days' WHERE invited_at IS NULL AND member_number <> ${r.member_number}`;
    const when = () =>
      new Date(
        Date.UTC(2200, 0, 1, 6) + Math.floor(Math.random() * 20000) * 86400_000,
      ).toISOString();
    await rpc(sql, "import_invites_run", when(), 20);
    const n = (
      await sql`SELECT recipient, category, template, data, recipient_user_id FROM public.notification_events WHERE dedupe_key = ${`import-invite:${await val(sql`SELECT id FROM public.imported_customers WHERE member_number = ${r.member_number}`)}`}`
    )[0]!;
    expect(n["template"]).toBe("member_import_invite");
    expect(n["category"]).toBe("transactional");
    expect(n["recipient"]).toBe(r.email.toLowerCase());
    expect(Object.keys(n["data"]).sort()).toEqual(["first_name", "username"]);
    await sql`UPDATE public.imported_customers SET invited_at = NULL WHERE member_number = ${r.member_number}`;
    await rpc(sql, "import_invites_run", when(), 20);
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.notification_events WHERE recipient = ${r.email.toLowerCase()}`,
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
    ]) {
      const [x] = await sql.unsafe(
        `SELECT has_function_privilege('authenticated', '${f}', 'execute') a, has_function_privilege('anon', '${f}', 'execute') b`,
      );
      expect([f, x!["a"], x!["b"]]).toEqual([f, false, false]);
    }
  });
});
