import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asUser,
  attempt,
  connect,
  failedWith,
  mkUser,
  uid,
  val,
  type Sql,
} from "./helpers";

/** "Report a bug": stored, one staff email per recipient, idempotent, rate-limited, locked down — real PostgreSQL. */
describe.skipIf(!DB_URL)("bug reports (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => {
    sql = connect(10);
  });
  afterAll(async () => {
    await sql.end();
  });

  /** The function takes a text[] of recipients, which the generic rpc helper would send as JSON. */
  const callSubmit = async (db: Sql, head: string[], inboxes: string[], key: string) => {
    const [r] =
      await db`SELECT public.bug_report_submit(${head[0]!}, ${head[1]!}, ${head[2]!}, ${head[3]!}, ${head[4]!}, ${head[5]!}, ${head[6]!}, ${`{${inboxes.map((i) => `"${i}"`).join(",")}}`}::text[], ${key}) AS r`;
    return r!["r"] as { id: string; replayed?: boolean };
  };
  const INBOXES = ["webmaster@cannaplug012.co.za", "cannaplug@gravitas.wtf"];
  const ip = () => `ip-${uid()}`;
  const submit = (over: Partial<Record<string, unknown>> = {}) => {
    const a = {
      name: "Thandi",
      email: "thandi@example.com",
      kind: "bug",
      message: "The Add button does nothing on my phone.",
      page: "/shop",
      agent: "Mozilla/5.0",
      ip: ip(),
      inboxes: INBOXES,
      key: `key-${uid()}`,
      ...over,
    };
    return callSubmit(
      sql,
      [a.name, a.email, a.kind, a.message, a.page, a.agent, a.ip] as string[],
      a.inboxes as string[],
      a.key as string,
    );
  };

  it("stores the report and queues one staff email for each recipient, with the details", async () => {
    const out = await submit({ message: "Checkout shows a blank page after I pay." });
    const row = (await sql`SELECT * FROM public.bug_reports WHERE id = ${out.id}`)[0]!;
    expect(row["kind"]).toBe("bug");
    expect(row["page"]).toBe("/shop");
    const mails =
      await sql`SELECT recipient, category, template, data FROM public.notification_events
                            WHERE dedupe_key LIKE ${`bugreport:${out.id}:%`} ORDER BY recipient`;
    expect(mails.map((m) => m["recipient"])).toEqual([...INBOXES].sort());
    expect(
      mails.every((m) => m["template"] === "bug_report_staff" && m["category"] === "staff"),
    ).toBe(true);
    expect(mails[0]!["data"]).toMatchObject({
      message: "Checkout shows a blank page after I pay.",
      page: "/shop",
    });
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.audit_log WHERE entity_id = ${out.id} AND action = 'bug_report_submitted'`,
      ),
    ).toBe(1);
  });

  it("name and email are optional", async () => {
    const out = await submit({
      name: "",
      email: "",
      kind: "idea",
      message: "Please add a dark mode toggle.",
    });
    const row = (await sql`SELECT name, email FROM public.bug_reports WHERE id = ${out.id}`)[0]!;
    expect(row["name"]).toBeNull();
    expect(row["email"]).toBeNull();
  });

  it("the same key twice stores and sends once", async () => {
    const key = `same-${uid()}`;
    const a = await submit({ key });
    const b = await submit({ key });
    expect(b).toMatchObject({ id: a.id, replayed: true });
    expect(
      await val(sql`SELECT count(*)::int FROM public.bug_reports WHERE idempotency_key = ${key}`),
    ).toBe(1);
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.notification_events WHERE dedupe_key LIKE ${`bugreport:${a.id}:%`}`,
      ),
    ).toBe(2);
  });

  it("refuses bad input: type, short message, bad email, bad inbox", async () => {
    expect(failedWith(await attempt(submit({ kind: "spam" })), "invalid_input")).toBe(true);
    expect(failedWith(await attempt(submit({ message: "too short" })), "invalid_input")).toBe(true);
    expect(failedWith(await attempt(submit({ message: "x".repeat(4001) })), "invalid_input")).toBe(
      true,
    );
    expect(failedWith(await attempt(submit({ email: "not-an-email" })), "invalid_input")).toBe(
      true,
    );
    expect(failedWith(await attempt(submit({ inboxes: ["nope"] })), "invalid_inbox")).toBe(true);
    expect(failedWith(await attempt(submit({ inboxes: [] })), "invalid_inbox")).toBe(true);
  });

  it("allows 5 reports an hour from one address and refuses the 6th (another address is unaffected)", async () => {
    const same = ip();
    for (let i = 0; i < 5; i++) await submit({ ip: same });
    expect(failedWith(await attempt(submit({ ip: same })), "rate_limited")).toBe(true);
    await submit({ ip: ip() });
  });

  it("browsers cannot call the function or read the reports", async () => {
    const u = await mkUser(sql, "customer");
    const out = await submit();
    expect(
      (
        await attempt(
          asUser(
            sql,
            u,
            async (tx) =>
              tx`SELECT public.bug_report_submit('a','','bug','long enough message here','/x','ua','h',array['a@b.co'],${`k-${uid()}`})`,
          ),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await attempt(
          asUser(sql, u, async (tx) => tx`SELECT * FROM public.bug_reports WHERE id = ${out.id}`),
        )
      ).ok,
    ).toBe(false);
  });

  it("mutation check: without the rate limit a sixth report from one address would be stored", async () => {
    const same = ip();
    for (let i = 0; i < 5; i++) await submit({ ip: same });
    const rolledBack = new Error("rollback");
    const out = await sql
      .begin(async (tx) => {
        const [fn] =
          await tx`SELECT pg_get_functiondef('public.bug_report_submit(text,text,text,text,text,text,text,text[],text)'::regprocedure) AS def`;
        const def = String(fn!["def"]);
        const broken = def.replace("IF v_recent >= 5 THEN", "IF false THEN");
        expect(broken).not.toBe(def);
        await tx.unsafe(broken);
        await callSubmit(
          tx as unknown as Sql,
          ["A", "", "bug", "A sixth report from one address", "/x", "ua", same],
          INBOXES,
          `k-${uid()}`,
        );
        throw rolledBack;
      })
      .catch((e) => e);
    expect(out).toBe(rolledBack);
    expect(failedWith(await attempt(submit({ ip: same })), "rate_limited")).toBe(true);
  });
});
