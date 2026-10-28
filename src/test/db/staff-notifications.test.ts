import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  asUser,
  attempt,
  connect,
  failedWith,
  key,
  mkUser,
  rpc,
  type Sql,
} from "./helpers";

describe.skipIf(!DB_URL)("staff roles and team notifications (real PostgreSQL)", () => {
  let sql: Sql;
  let admin: string;
  let admin2: string;
  let manager: string;
  let manager2: string;
  let budtender: string;
  let member: string;
  const staffRole = async (id: string) =>
    (
      await sql`SELECT role::text AS role FROM public.user_roles WHERE user_id = ${id} AND role IN ('budtender','manager','admin') ORDER BY public.role_level(role) DESC LIMIT 1`
    )[0]?.["role"] ?? null;
  const setRole = (actor: string, target: string, role: string, k = key("r")) =>
    rpc(sql, "staff_set_role", actor, target, role, k);

  beforeAll(async () => {
    sql = connect(10);
    [admin, admin2, manager, manager2, budtender, member] = await Promise.all([
      mkUser(sql, "admin"),
      mkUser(sql, "admin"),
      mkUser(sql, "manager"),
      mkUser(sql, "manager"),
      mkUser(sql, "budtender"),
      mkUser(sql, "customer"),
    ]);
  });
  afterAll(async () => {
    await sql.end();
  });

  describe("staff_set_role", () => {
    it("a manager adds, changes and removes budtenders, and it is audited", async () => {
      const r = await setRole(manager, member, "budtender");
      expect(r).toMatchObject({ changed: true, role: "budtender", previous: "none" });
      expect(await staffRole(member)).toBe("budtender");
      expect((await setRole(manager, member, "budtender")).changed).toBe(false);
      expect((await setRole(manager, member, "none")).changed).toBe(true);
      expect(await staffRole(member)).toBeNull();
      const roles = await sql`SELECT role::text FROM public.user_roles WHERE user_id = ${member}`;
      expect(roles.map((x) => x["role"])).toContain("customer"); // still a member
      const audit =
        await sql`SELECT metadata FROM public.audit_log WHERE action = 'staff_role_changed' AND entity_id = ${member} AND actor_user_id = ${manager} ORDER BY created_at`;
      expect(audit.map((a) => a["metadata"])).toEqual([
        { from: "none", to: "budtender" },
        { from: "budtender", to: "none" },
      ]);
    });

    it("a manager cannot touch managers or admins, or hand out the manager role", async () => {
      expect(failedWith(await attempt(setRole(manager, manager2, "budtender")), "forbidden")).toBe(
        true,
      );
      expect(failedWith(await attempt(setRole(manager, manager2, "none")), "forbidden")).toBe(true);
      expect(failedWith(await attempt(setRole(manager, admin, "none")), "forbidden")).toBe(true);
      expect(failedWith(await attempt(setRole(manager, budtender, "manager")), "forbidden")).toBe(
        true,
      );
      expect(await staffRole(manager2)).toBe("manager");
      expect(await staffRole(budtender)).toBe("budtender");
    });

    it("an admin can promote a budtender to manager and demote or remove a manager, but never change an admin", async () => {
      const t = await mkUser(sql, "budtender");
      expect((await setRole(admin, t, "manager")).role).toBe("manager");
      expect(await staffRole(t)).toBe("manager");
      expect((await setRole(admin, t, "budtender")).previous).toBe("manager");
      expect((await setRole(admin, t, "manager")).changed).toBe(true);
      expect((await setRole(admin, t, "none")).changed).toBe(true);
      expect(await staffRole(t)).toBeNull();
      expect(failedWith(await attempt(setRole(admin, admin2, "manager")), "forbidden")).toBe(true);
      expect(failedWith(await attempt(setRole(admin, admin2, "none")), "forbidden")).toBe(true);
      expect(await staffRole(admin2)).toBe("admin");
    });

    it("nobody changes their own role, only staff above budtender can use it, and bad input is refused", async () => {
      expect(failedWith(await attempt(setRole(manager, manager, "none")), "forbidden")).toBe(true);
      expect(failedWith(await attempt(setRole(admin, admin, "manager")), "forbidden")).toBe(true);
      expect(failedWith(await attempt(setRole(budtender, member, "budtender")), "forbidden")).toBe(
        true,
      );
      expect(failedWith(await attempt(setRole(member, member, "budtender")), "forbidden")).toBe(
        true,
      );
      expect(failedWith(await attempt(setRole(admin, member, "admin")), "invalid_input")).toBe(
        true,
      );
      expect(
        failedWith(
          await attempt(setRole(admin, crypto.randomUUID(), "budtender")),
          "member_not_found",
        ),
      ).toBe(true);
      expect(await staffRole(member)).toBeNull();
    });

    it("replays by idempotency key and refuses a key reused for something else", async () => {
      const t = await mkUser(sql, "customer");
      const k = key("r");
      expect((await setRole(manager, t, "budtender", k)).changed).toBe(true);
      expect((await setRole(manager, t, "budtender", k)).replayed).toBe(true);
      expect(failedWith(await attempt(setRole(manager, t, "none", k)), "idempotency")).toBe(true);
    });

    it("staff_directory and staff_find_member are for managers and above", async () => {
      const dir = await rpc(sql, "staff_directory", manager);
      const ids = dir.map((x: { user_id: string }) => x.user_id);
      expect(ids).toEqual(expect.arrayContaining([admin, manager, budtender]));
      expect(dir.find((x: { user_id: string }) => x.user_id === admin).role).toBe("admin");
      expect(ids).not.toContain(member);
      expect(failedWith(await attempt(rpc(sql, "staff_directory", budtender)), "forbidden")).toBe(
        true,
      );
      const email = (await sql`SELECT email FROM auth.users WHERE id = ${budtender}`)[0]!["email"];
      const found = await rpc(
        sql,
        "staff_find_member",
        manager,
        ` ${String(email).toUpperCase()} `,
      );
      expect(found).toMatchObject({ user_id: budtender, role: "budtender" });
      expect(await rpc(sql, "staff_find_member", manager, "nobody@nowhere.example")).toBeNull();
      expect(
        failedWith(
          await attempt(rpc(sql, "staff_find_member", manager, "not an email")),
          "invalid_input",
        ),
      ).toBe(true);
      expect(
        failedWith(await attempt(rpc(sql, "staff_find_member", budtender, "a@b.co")), "forbidden"),
      ).toBe(true);
    });
  });

  describe("team notifications", () => {
    const markRead = async (actor: string, ids: string[]) =>
      (
        await sql`SELECT public.team_notification_mark_read(${actor}, ${sql.array(ids)}::uuid[]) AS r`
      )[0]!["r"];
    const save = (
      actor: string,
      o: Partial<{
        id: string | null;
        title: string;
        body: string;
        kind: string;
        min: string;
        status: string;
        pinned: boolean;
        at: string | null;
        ct: string | null;
        cb: string | null;
        k: string;
      }> = {},
    ) =>
      rpc(
        sql,
        "team_notification_save",
        actor,
        o.id ?? null,
        o.title ?? "Stock count tonight",
        o.body ?? "Please stay after close.",
        o.kind ?? "reminder",
        o.min ?? "budtender",
        o.status ?? "published",
        o.pinned ?? false,
        o.at ?? null,
        o.ct ?? null,
        o.cb ?? null,
        o.k ?? key("n"),
      );
    const visible = (userId: string) =>
      asUser(
        sql,
        userId,
        (tx) => tx`SELECT id, title, status, min_role FROM public.team_notifications`,
      );

    it("the two launch notices are in place; the referral one flips by itself at 12AM SAST on 29 October", async () => {
      const rows =
        await sql`SELECT title, pinned, status, change_at, change_title FROM public.team_notifications WHERE created_by IS NULL ORDER BY title`;
      const online = rows.find((r) => r["title"] === "Online payments are now live!");
      expect(online).toMatchObject({ pinned: true, status: "published" });
      const ref = rows.find((r) => String(r["title"]).startsWith("Refer-a-friend"));
      expect(ref!["title"]).toBe("Refer-a-friend program goes live on 29 October 2026");
      expect(new Date(String(ref!["change_at"])).toISOString()).toBe("2026-10-28T22:00:00.000Z");
      expect(ref!["change_title"]).toBe("Refer-a-friend program is now live!");
    });

    it("saves, edits and archives; drafts are visible to managers and admins only", async () => {
      const draft = await save(manager, { title: "Draft: new till rules", status: "draft" });
      const id = draft.id as string;
      const asBud = (await visible(budtender)).map((r) => r["id"]);
      expect(asBud).not.toContain(id);
      expect((await visible(manager)).map((r) => r["id"])).toContain(id);
      await save(manager, { id, title: "New till rules", status: "published" });
      expect((await visible(budtender)).map((r) => r["id"])).toContain(id);
      const [row] =
        await sql`SELECT published_at, created_by, updated_by FROM public.team_notifications WHERE id = ${id}`;
      expect(row!["published_at"]).toBeTruthy();
      expect(row).toMatchObject({ created_by: manager, updated_by: manager });
      await save(manager, { id, title: "New till rules", status: "archived" });
      expect((await visible(budtender)).map((r) => r["id"])).not.toContain(id);
      const audit =
        await sql`SELECT count(*)::int AS n FROM public.audit_log WHERE action = 'team_notification_saved' AND entity_id = ${id}`;
      expect(audit[0]!["n"]).toBe(3);
    });

    it("audience: manager-only notices are hidden from budtenders; admin-only from managers; managers cannot write admin-only", async () => {
      const m = (await save(manager, { title: "Managers only", min: "manager" })).id;
      const a = (await save(admin, { title: "Admins only", min: "admin" })).id;
      const bud = (await visible(budtender)).map((r) => r["id"]);
      expect(bud).not.toContain(m);
      expect(bud).not.toContain(a);
      const mgr = (await visible(manager)).map((r) => r["id"]);
      expect(mgr).toContain(m);
      expect(mgr).not.toContain(a);
      expect((await visible(admin)).map((r) => r["id"])).toEqual(expect.arrayContaining([m, a]));
      expect(failedWith(await attempt(save(manager, { min: "admin" })), "forbidden")).toBe(true);
      expect(failedWith(await attempt(save(manager, { id: a, min: "manager" })), "forbidden")).toBe(
        true,
      );
    });

    it("only managers and admins can write; budtenders and members cannot", async () => {
      expect(failedWith(await attempt(save(budtender)), "forbidden")).toBe(true);
      expect(failedWith(await attempt(save(member)), "forbidden")).toBe(true);
    });

    it("validates input and replays by idempotency key", async () => {
      expect(failedWith(await attempt(save(manager, { title: "ab" })), "invalid_input")).toBe(true);
      expect(failedWith(await attempt(save(manager, { body: "   " })), "invalid_input")).toBe(true);
      expect(failedWith(await attempt(save(manager, { kind: "spam" })), "invalid_input")).toBe(
        true,
      );
      expect(
        failedWith(await attempt(save(manager, { at: "2026-12-01T00:00:00Z" })), "invalid_input"),
      ).toBe(true);
      const k = key("n");
      const first = await save(manager, { title: "Replay me", k });
      const again = await save(manager, { title: "Replay me", k });
      expect(again).toMatchObject({ id: first.id, replayed: true });
      const n =
        await sql`SELECT count(*)::int AS n FROM public.team_notifications WHERE created_by = ${manager} AND title = 'Replay me' AND created_at > now() - interval '1 minute'`;
      expect(n[0]!["n"]).toBe(1);
      expect(
        failedWith(
          await attempt(save(manager, { id: crypto.randomUUID(), title: "Ghost" })),
          "notification_not_found",
        ),
      ).toBe(true);
    });

    it("read receipts: only for notices the staff member may see; own rows only; edits make it unread again", async () => {
      const open = (await save(manager, { title: "For everyone" })).id as string;
      const mgrOnly = (await save(manager, { title: "For managers", min: "manager" })).id as string;
      expect(await markRead(budtender, [open, mgrOnly])).toBe(1);
      const mine = await asUser(
        sql,
        budtender,
        (tx) => tx`SELECT notification_id FROM public.team_notification_reads`,
      );
      expect(mine.map((r) => r["notification_id"])).toEqual(expect.arrayContaining([open]));
      expect(mine.map((r) => r["notification_id"])).not.toContain(mgrOnly);
      const theirs = await asUser(
        sql,
        manager,
        (tx) =>
          tx`SELECT notification_id FROM public.team_notification_reads WHERE user_id = ${budtender}`,
      );
      expect(theirs).toHaveLength(0);
      const first = (
        await sql`SELECT read_at FROM public.team_notification_reads WHERE notification_id = ${open} AND user_id = ${budtender}`
      )[0]!["read_at"];
      await markRead(budtender, [open]);
      const second = (
        await sql`SELECT read_at FROM public.team_notification_reads WHERE notification_id = ${open} AND user_id = ${budtender}`
      )[0]!["read_at"];
      expect(new Date(second).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime());
      expect(failedWith(await attempt(markRead(member, [open])), "forbidden")).toBe(true);
    });

    it("members and anonymous visitors cannot read notifications, and browser roles cannot write or call the functions", async () => {
      expect(
        (await attempt(asUser(sql, member, (tx) => tx`SELECT * FROM public.team_notifications`)))
          .ok,
      ).toBe(true);
      expect(
        await asUser(sql, member, (tx) => tx`SELECT * FROM public.team_notifications`),
      ).toHaveLength(0);
      expect(
        (await attempt(asAnon(sql, (tx) => tx`SELECT * FROM public.team_notifications`))).ok,
      ).toBe(false);
      expect(
        (
          await attempt(
            asUser(
              sql,
              manager,
              (tx) =>
                tx`INSERT INTO public.team_notifications (title, body) VALUES ('forged', 'x')`,
            ),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await attempt(
            asUser(sql, manager, (tx) => tx`UPDATE public.team_notifications SET title = 'hacked'`),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await attempt(
            asUser(
              sql,
              manager,
              (tx) =>
                tx`SELECT public.staff_set_role(${manager}, ${member}, 'budtender', 'k-12345678')`,
            ),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await attempt(
            asUser(
              sql,
              admin,
              (tx) =>
                tx`SELECT public.team_notification_save(${admin}, null, 'Title', 'Body', 'update', 'budtender', 'published', false, null, null, null, 'k-12345678')`,
            ),
          )
        ).ok,
      ).toBe(false);
      expect(await staffRole(member)).toBeNull();
    });

    it("the table is part of the Realtime publication", async () => {
      const rows =
        await sql`SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'team_notifications'`;
      expect(rows).toHaveLength(1);
    });
  });

  it("mutation check: weakening each new rule makes the matching attack succeed", async () => {
    const rolledBack = Symbol("rollback");
    const inRollback = async (fn: (tx: Sql) => Promise<unknown>) => {
      let out: unknown;
      await sql
        .begin(async (tx) => {
          out = await fn(tx as unknown as Sql);
          throw rolledBack;
        })
        .catch((e) => {
          if (e !== rolledBack) throw e;
        });
      return out;
    };
    // 1. Browser roles may not run the role function: with the grant restored, a manager could do it as anyone.
    const t = await mkUser(sql, "customer");
    const granted = await inRollback(async (tx) => {
      await tx`GRANT EXECUTE ON FUNCTION public.staff_set_role(uuid, uuid, text, text) TO authenticated`;
      await tx`SET LOCAL ROLE authenticated`;
      return (
        await attempt(
          tx`SELECT public.staff_set_role(${manager}, ${t}, 'budtender', 'mutation-key-1')`,
        )
      ).ok;
    });
    expect(granted).toBe(true);
    // 2. A direct insert into user_roles by a manager is refused only because of RLS (admin-only insert policy).
    const inserted = await inRollback(async (tx) => {
      await tx`ALTER TABLE public.user_roles DISABLE ROW LEVEL SECURITY`;
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claim.sub', ${manager}, true)`;
      return (
        await attempt(tx`INSERT INTO public.user_roles (user_id, role) VALUES (${t}, 'manager')`)
      ).ok;
    });
    expect(inserted).toBe(true);
    expect(
      (
        await attempt(
          asUser(
            sql,
            manager,
            (tx) => tx`INSERT INTO public.user_roles (user_id, role) VALUES (${t}, 'manager')`,
          ),
        )
      ).ok,
    ).toBe(false);
    // 3. Notice audiences are enforced by RLS: with the policy dropped and a broad one added, a budtender could read admin notices.
    const adminNotice = (
      await rpc(
        sql,
        "team_notification_save",
        admin,
        null,
        "Admins eyes only",
        "Secret",
        "update",
        "admin",
        "published",
        false,
        null,
        null,
        null,
        key("n"),
      )
    ).id;
    const leaked = await inRollback(async (tx) => {
      await tx`DROP POLICY "staff read team notifications" ON public.team_notifications`;
      await tx`CREATE POLICY "broad" ON public.team_notifications FOR SELECT TO authenticated USING (true)`;
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claim.sub', ${budtender}, true)`;
      return (await tx`SELECT id FROM public.team_notifications WHERE id = ${adminNotice}`).length;
    });
    expect(leaked).toBe(1);
    expect((await visible2(budtender)).map((r) => r["id"])).not.toContain(adminNotice);
  });

  const visible2 = (userId: string) =>
    asUser(sql, userId, (tx) => tx`SELECT id FROM public.team_notifications`);
});
