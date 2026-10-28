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

describe.skipIf(!DB_URL)("journal likes and comments (real PostgreSQL)", () => {
  let sql: Sql;
  let member: string;
  let other: string;
  let manager: string;
  let budtender: string;
  let article: string;
  let future: string;

  beforeAll(async () => {
    sql = connect(10);
    member = await mkUser(sql, "customer");
    other = await mkUser(sql, "customer");
    manager = await mkUser(sql, "manager");
    budtender = await mkUser(sql, "budtender");
    await sql`UPDATE public.profiles SET full_name = 'Thandi Mokoena' WHERE id = ${member}`;
    [{ id: article }] = await sql`
      INSERT INTO public.articles (slug, title, excerpt, category, body_md, published_at)
      VALUES (${"t-" + key("a")}, 'T', 'E', 'Culture', '## One', now() - interval '1 hour') RETURNING id`;
    [{ id: future }] = await sql`
      INSERT INTO public.articles (slug, title, excerpt, category, body_md, published_at)
      VALUES (${"f-" + key("a")}, 'F', 'E', 'Culture', '## One', now() + interval '1 day') RETURNING id`;
  });
  afterAll(async () => {
    await sql.end();
  });

  const like = (actor: string | null, id = article, liked = true) =>
    rpc(sql, "article_set_like", actor, id, liked);
  const comment = (actor: string | null, body: string, k = key("c"), id = article) =>
    rpc(sql, "article_add_comment", actor, id, body, k);

  it("likes persist per member, are idempotent, and unliking keeps the count honest", async () => {
    expect((await like(member)).like_count).toBe(1);
    expect((await like(member)).like_count).toBe(1);
    expect((await like(other)).like_count).toBe(2);
    expect((await like(member, article, false)).like_count).toBe(1);
    const [row] =
      await sql`SELECT liked FROM public.article_likes WHERE article_id = ${article} AND user_id = ${member}`;
    expect(row!["liked"]).toBe(false);
    const audits =
      await sql`SELECT action FROM public.audit_log WHERE entity_id = ${article} AND actor_user_id = ${member}
                             AND action IN ('article_liked','article_unliked') ORDER BY created_at`;
    expect(audits.map((a) => a["action"])).toEqual(["article_liked", "article_unliked"]);
  });

  it("only a real signed-in member can like or comment, and unpublished articles are invisible", async () => {
    expect(failedWith(await attempt(like(null)), "forbidden")).toBe(true);
    expect(failedWith(await attempt(comment(null, "Hello there")), "forbidden")).toBe(true);
    expect(failedWith(await attempt(like(crypto.randomUUID())), "forbidden")).toBe(true);
    expect((await attempt(like(member, future))).ok).toBe(false);
    expect((await attempt(comment(member, "Hello there", key("c"), future))).ok).toBe(false);
  });

  it("comments show first name and last initial, replay by key, and reject repeats, spam and bad input", async () => {
    const k = key("c");
    const first = await comment(member, "Really useful, thank you.", k);
    expect(first.display_name).toBe("Thandi M.");
    expect((await comment(member, "Really useful, thank you.", k)).replayed).toBe(true);
    expect(
      failedWith(await attempt(comment(member, "Really useful, thank you.")), "duplicate_comment"),
    ).toBe(true);
    expect(failedWith(await attempt(comment(other, "x")), "invalid_input")).toBe(true);
    expect(failedWith(await attempt(comment(other, "y".repeat(1001))), "invalid_input")).toBe(true);
    expect(
      failedWith(await attempt(comment(other, "http://a http://b http://c")), "invalid_input"),
    ).toBe(true);
    expect(failedWith(await attempt(comment(other, "bad \u0001 text")), "invalid_input")).toBe(
      true,
    );
  });

  it("rate limits to five comments in ten minutes", async () => {
    const u = await mkUser(sql, "customer");
    for (let i = 0; i < 5; i++) await comment(u, `Comment number ${i} here`);
    expect(failedWith(await attempt(comment(u, "One more comment")), "rate_limited")).toBe(true);
  });

  it("browser roles can read nothing and write nothing directly; the functions are service-role only", async () => {
    for (const t of ["article_likes", "article_comments"]) {
      expect(
        (await attempt(asUser(sql, member, (tx) => tx.unsafe(`SELECT * FROM public.${t}`)))).ok,
      ).toBe(false);
      expect((await attempt(asAnon(sql, (tx) => tx.unsafe(`SELECT * FROM public.${t}`)))).ok).toBe(
        false,
      );
    }
    expect(
      (
        await attempt(
          asUser(
            sql,
            member,
            (tx) => tx`INSERT INTO public.article_comments (article_id, user_id, display_name, body)
        VALUES (${article}, ${member}, 'X', 'forged')`,
          ),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await attempt(
          asUser(
            sql,
            member,
            (tx) => tx`SELECT public.article_set_like(${member}, ${article}, true)`,
          ),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await attempt(
          asAnon(
            sql,
            (tx) => tx`SELECT public.article_add_comment(${member}, ${article}, 'hi there', 'k')`,
          ),
        )
      ).ok,
    ).toBe(false);
  });

  it("only manager and above can hide a comment, with a reason, and it stays stored", async () => {
    const { comment_id } = await comment(other, "Please hide this one");
    expect(
      failedWith(
        await attempt(rpc(sql, "article_hide_comment", budtender, comment_id, "spam")),
        "forbidden",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(rpc(sql, "article_hide_comment", member, comment_id, "spam")),
        "forbidden",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(rpc(sql, "article_hide_comment", manager, comment_id, " ")),
        "reason_required",
      ),
    ).toBe(true);
    await rpc(sql, "article_hide_comment", manager, comment_id, "off topic");
    const [row] =
      await sql`SELECT hidden_at, hidden_by, hide_reason FROM public.article_comments WHERE id = ${comment_id}`;
    expect(row).toMatchObject({ hidden_by: manager, hide_reason: "off topic" });
    expect(row!["hidden_at"]).toBeTruthy();
    expect(
      failedWith(
        await attempt(rpc(sql, "article_hide_comment", manager, comment_id, "again")),
        "comment_not_found",
      ),
    ).toBe(true);
  });

  it("mutation check: weakening each security rule makes the matching attack succeed", async () => {
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
    // 1. Browser roles may not run the functions: with the grant restored, a member could like as anyone.
    const granted = await inRollback(async (tx) => {
      await tx`GRANT EXECUTE ON FUNCTION public.article_set_like(uuid, uuid, boolean) TO authenticated`;
      await tx`SET LOCAL ROLE authenticated`;
      return (await attempt(tx`SELECT public.article_set_like(${other}, ${article}, true)`)).ok;
    });
    expect(granted).toBe(true);
    // 2. RLS keeps comments private to the service: with RLS off, a member could read the table.
    const readable = await inRollback(async (tx) => {
      await tx`ALTER TABLE public.article_comments DISABLE ROW LEVEL SECURITY`;
      await tx`GRANT SELECT ON public.article_comments TO authenticated`;
      await tx`SET LOCAL ROLE authenticated`;
      return (await attempt(tx`SELECT count(*) FROM public.article_comments`)).ok;
    });
    expect(readable).toBe(true);
    // 3. The manager gate on hiding: with the staff check bypassed (a budtender made manager) it would pass,
    //    so the real refusal above is the role check and not an accident of the arguments.
    const { comment_id } = await comment(other, "Hide gate mutation check");
    const hidden = await inRollback(async (tx) => {
      await tx`INSERT INTO public.user_roles (user_id, role) VALUES (${member}, 'manager') ON CONFLICT DO NOTHING`;
      return (await attempt(rpc(tx, "article_hide_comment", member, comment_id, "mutation check")))
        .ok;
    });
    expect(hidden).toBe(true);
    expect(
      failedWith(
        await attempt(rpc(sql, "article_hide_comment", member, comment_id, "mutation check")),
        "forbidden",
      ),
    ).toBe(true);
  });

  it("the launch articles and their seeded comments are in place, dated 25 to 28 October 2026", async () => {
    const rows = await sql`SELECT slug, author_name, featured, published_at::date::text AS d,
        (SELECT count(*)::int FROM public.article_comments c WHERE c.article_id = a.id AND c.is_seed) AS seeds
      FROM public.articles a WHERE author_name = 'Dithekgo M.' ORDER BY published_at`;
    expect(rows.map((r) => r["d"])).toEqual([
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
    ]);
    for (const r of rows) {
      expect(r["featured"]).toBe(true);
      expect(r["seeds"]).toBeGreaterThanOrEqual(1);
      expect(r["seeds"]).toBeLessThanOrEqual(3);
    }
  });
});
