import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  asUser,
  attempt,
  connect,
  failedWith,
  key,
  mkMember,
  rpc,
  type Sql,
} from "./helpers";

/** Ask The Plug intro: shown once per member on any device. Real PostgreSQL. */
describe.skipIf(!DB_URL)("member feature announcements (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => {
    sql = connect(10);
  });
  afterAll(async () => {
    await sql.end();
  });

  const seen = (u: string) => rpc<string[]>(sql, "member_features_seen", u);
  const mark = (u: string, feature: string, action: string, k = key("seen")) =>
    rpc(sql, "member_feature_mark_seen", u, feature, action, k);

  it("records once per member and feature; the first action wins; audited once", async () => {
    const u = await mkMember(sql);
    expect(await seen(u)).toEqual([]);
    const k = key("seen");
    expect(await mark(u, "ask_the_plug_intro", "opened", k)).toMatchObject({ recorded: true });
    expect(await mark(u, "ask_the_plug_intro", "opened", k)).toMatchObject({ recorded: true }); // replay
    expect(await mark(u, "ask_the_plug_intro", "dismissed")).toMatchObject({ recorded: false });
    expect(await seen(u)).toEqual(["ask_the_plug_intro"]);
    const [row] = await sql`SELECT action FROM public.member_feature_seen WHERE user_id = ${u}`;
    expect(row!["action"]).toBe("opened");
    const [a] = await sql`SELECT count(*)::int AS n FROM public.audit_log
      WHERE action = 'member_feature_seen' AND actor_user_id = ${u}`;
    expect(a!["n"]).toBe(1);
  });

  it("keeps members apart and refuses bad input", async () => {
    const [a, b] = [await mkMember(sql), await mkMember(sql)];
    await mark(a, "ask_the_plug_preview", "dismissed");
    expect(await seen(b)).toEqual([]);
    expect(failedWith(await attempt(mark(a, "Ask The Plug!", "opened")), "invalid_input")).toBe(
      true,
    );
    expect(failedWith(await attempt(mark(a, "ask_the_plug_intro", "liked")), "invalid_input")).toBe(
      true,
    );
    expect(
      failedWith(
        await attempt(mark(crypto.randomUUID(), "ask_the_plug_intro", "opened")),
        "not_authenticated",
      ),
    ).toBe(true);
  });

  it("browsers cannot read or write it, even for themselves", async () => {
    const u = await mkMember(sql);
    for (const run of [
      (tx: Sql) => tx`SELECT * FROM public.member_feature_seen`,
      (tx: Sql) => tx`SELECT public.member_features_seen(${u})`,
      (tx: Sql) =>
        tx`SELECT public.member_feature_mark_seen(${u}, 'ask_the_plug_intro', 'opened', ${key("x")})`,
      (tx: Sql) =>
        tx`INSERT INTO public.member_feature_seen (user_id, feature, action) VALUES (${u}, 'ask_the_plug_intro', 'opened')`,
    ]) {
      expect((await attempt(asUser(sql, u, run))).ok).toBe(false);
      expect((await attempt(asAnon(sql, run))).ok).toBe(false);
    }
  });

  it("mutation check: granting the table to members would let a member mark it for someone else", async () => {
    const [a, b] = [await mkMember(sql), await mkMember(sql)];
    const rolledBack = new Error("rollback");
    const out = await sql
      .begin(async (tx) => {
        await tx`GRANT INSERT ON public.member_feature_seen TO authenticated`;
        await tx`CREATE POLICY mutant ON public.member_feature_seen FOR INSERT TO authenticated WITH CHECK (true)`;
        await tx`SET LOCAL ROLE authenticated`;
        await tx`SELECT set_config('request.jwt.claim.sub', ${a}, true)`;
        const r = await attempt(
          tx`INSERT INTO public.member_feature_seen (user_id, feature, action) VALUES (${b}, 'ask_the_plug_intro', 'opened')`,
        );
        throw Object.assign(rolledBack, { r });
      })
      .catch((e) =>
        e === rolledBack ? (e as Error & { r: { ok: boolean } }).r : Promise.reject(e),
      );
    expect(out.ok).toBe(true); // the mutant lets it through, so the real lockdown is what stops it
    expect(await seen(b)).toEqual([]);
  });
});
