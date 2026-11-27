import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  asUser,
  attempt,
  cash,
  connect,
  failedWith,
  key,
  mkMember,
  mkProduct,
  mkSession,
  mkUser,
  receive,
  rpc,
  sell,
  val,
  type Sql,
} from "./helpers";

/** 20261127012000 — dab hit waiver, health screening and indemnity declaration. Real PostgreSQL. */
describe.skipIf(!DB_URL)("dab waivers (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let budtender: string;
  const SIG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
    budtender = await mkUser(sql, "budtender");
  });
  afterAll(async () => {
    await sql.end();
  });

  const adult = "1990-05-01";
  const form = (over: Record<string, unknown> = {}) => ({
    customer_name: "Ada Lovelace",
    date_of_birth: adult,
    id_number: "9005015800087",
    age_confirmed: true,
    popia_consent: true,
    alcohol: { had: false },
    drugs: { had: false },
    medication: { had: false },
    under_influence: false,
    conditions: [],
    emergency: { name: "Charles Babbage", relationship: "Friend", phone: "0820000000" },
    signature: SIG,
    staff_noted_signs: false,
    ...over,
  });
  const create = (over: Record<string, unknown> = {}, actor = budtender) =>
    rpc(sql, "dab_waiver_create", actor, form(over));

  it("a budtender can sign someone in but cannot read the waiver back; a manager can", async () => {
    const w = await create();
    expect(w).toMatchObject({ status: "valid", decline_reasons: [], flagged: false });
    expect(
      failedWith(await attempt(rpc(sql, "dab_waiver_get", budtender, w.id)), "forbidden"),
    ).toBe(true);
    const seen = await rpc(sql, "dab_waiver_get", manager, w.id);
    expect(seen).toMatchObject({
      customer_name: "Ada Lovelace",
      id_number: "9005015800087",
      status: "valid",
    });
    expect(seen.signature).toBe(SIG);
    expect(failedWith(await attempt(rpc(sql, "dab_waiver_list", budtender)), "forbidden")).toBe(
      true,
    );
    const list = (await rpc(sql, "dab_waiver_list", manager, 50, null, "lovelace")) as {
      id: string;
    }[];
    expect(list.some((r) => r.id === w.id)).toBe(true);
  });

  it("members and browsers cannot create, claim or read anything", async () => {
    const member = await mkMember(sql);
    expect(
      failedWith(await attempt(rpc(sql, "dab_waiver_create", member, form())), "forbidden"),
    ).toBe(true);
    expect(
      (await attempt(asUser(sql, budtender, async (tx) => tx`SELECT * FROM public.dab_waivers`)))
        .ok,
    ).toBe(false);
    expect(
      (
        await attempt(
          asAnon(sql, async (tx) => tx`SELECT public.dab_waiver_list(${manager}, 5, NULL, NULL)`),
        )
      ).ok,
    ).toBe(false);
  });

  it("keeps names and health answers out of the audit log", async () => {
    const w = await create({
      customer_name: "Zelda Quartz",
      conditions: ["asthma"],
      condition_details: "mild asthma",
    });
    const rows =
      await sql`SELECT metadata::text AS m FROM public.audit_log WHERE entity_id = ${w.id}`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(String(r["m"])).not.toMatch(/Zelda|asthma/i);
    }
  });

  it("declines under-18s, people under the influence, pregnancy and staff concern, and keeps the record", async () => {
    const young = new Date(Date.now() - 17 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    expect(await create({ date_of_birth: young, signature: null })).toMatchObject({
      status: "declined",
      decline_reasons: ["under_18"],
    });
    expect(await create({ under_influence: true })).toMatchObject({
      status: "declined",
      decline_reasons: ["under_the_influence"],
    });
    expect(await create({ conditions: ["pregnant"], condition_details: "pregnant" })).toMatchObject(
      {
        status: "declined",
        decline_reasons: ["pregnant_or_breastfeeding"],
      },
    );
    expect(await create({ staff_noted_signs: true, staff_details: "slurring" })).toMatchObject({
      status: "declined",
      decline_reasons: ["staff_concern"],
    });
    const declined = await create({ under_influence: true });
    expect(
      failedWith(
        await attempt(rpc(sql, "dab_waiver_claim", budtender, declined.id, key("sale"))),
        "waiver_invalid",
      ),
    ).toBe(true);
  });

  it("refuses incomplete forms", async () => {
    for (const [over, why] of [
      [{ customer_name: "A" }, "full name"],
      [{ id_number: "12" }, "ID or passport"],
      [{ date_of_birth: "nope" }, "date of birth"],
      [{ popia_consent: false }, "consent"],
      [{ signature: null }, "signature"],
      [{ age_confirmed: false }, "age confirmation"],
      [{ drugs: { had: true } }, "what drugs"],
      [{ medication: { had: true } }, "which medicine"],
      [{ conditions: ["asthma"] }, "details of the conditions"],
      [{ conditions: ["flu"], condition_details: "x" }, "unknown condition"],
      [{ emergency: { name: "Bob", phone: "1" } }, "emergency contact"],
      [{ signature: "data:text/html;base64,AAAA" }, "signature is not valid"],
    ] as [Record<string, unknown>, string][]) {
      const o = await attempt(create(over));
      expect(o.ok, why).toBe(false);
      expect(failedWith(o, "waiver_invalid") || !o.ok, why).toBe(true);
    }
  });

  it("flags health answers for staff without blocking", async () => {
    const w = await create({
      alcohol: { had: true, hours_ago: 6 },
      conditions: ["asthma"],
      condition_details: "mild",
    });
    expect(w).toMatchObject({ status: "valid", flagged: true });
  });

  it("a waiver is for one sale, on the day it was signed", async () => {
    const w = await create();
    const k1 = key("sale");
    await rpc(sql, "dab_waiver_claim", budtender, w.id, k1);
    await rpc(sql, "dab_waiver_claim", budtender, w.id, k1); // the same sale retried is fine
    expect(
      failedWith(
        await attempt(rpc(sql, "dab_waiver_claim", budtender, w.id, key("other"))),
        "waiver_invalid",
      ),
    ).toBe(true);
    await rpc(sql, "dab_waiver_release", budtender, w.id, k1);
    await rpc(sql, "dab_waiver_claim", budtender, w.id, key("again")); // released after a failed sale

    const w2 = await create();
    await sql`UPDATE public.dab_waivers SET signed_at = now() - interval '1 day' WHERE id = ${w2.id}`;
    expect(
      failedWith(
        await attempt(rpc(sql, "dab_waiver_claim", budtender, w2.id, key("sale"))),
        "waiver_invalid",
      ),
    ).toBe(true);
  });

  it("links to the sale it was used for and cannot be reused afterwards", async () => {
    const { sessionId } = await mkSession(sql, manager, budtender);
    const p = await mkProduct(sql, 80);
    await receive(sql, manager, p, 5);
    const w = await create();
    const k = key("sale");
    await rpc(sql, "dab_waiver_claim", budtender, w.id, k);
    const sale = await sell(
      sql,
      budtender,
      sessionId,
      [{ product_id: p, quantity: 1 }],
      [cash("80")],
      { idem: k },
    );
    await rpc(sql, "dab_waiver_link_sale", budtender, w.id, k, sale.sale_id);
    expect(
      failedWith(
        await attempt(rpc(sql, "dab_waiver_claim", budtender, w.id, key("next"))),
        "waiver_invalid",
      ),
    ).toBe(true);
    const seen = await rpc(sql, "dab_waiver_get", manager, w.id);
    expect(seen.sale_id).toBe(sale.sale_id);
    expect(seen.receipt_number).toBeTruthy();
  });

  it("records an incident; after 24 hours only a manager can add one", async () => {
    const w = await create();
    await rpc(
      sql,
      "dab_waiver_record_incident",
      budtender,
      w.id,
      "Felt faint, sat down",
      true,
      false,
      "16:20",
      "Water given",
    );
    const seen = await rpc(sql, "dab_waiver_get", manager, w.id);
    expect(seen.incident).toMatchObject({
      text: "Felt faint, sat down",
      emergency_services: true,
      emergency_contact: false,
    });
    await sql`UPDATE public.dab_waivers SET signed_at = now() - interval '2 days' WHERE id = ${w.id}`;
    expect(
      failedWith(
        await attempt(
          rpc(
            sql,
            "dab_waiver_record_incident",
            budtender,
            w.id,
            "Later note",
            false,
            false,
            null,
            null,
          ),
        ),
        "forbidden",
      ),
    ).toBe(true);
    await rpc(
      sql,
      "dab_waiver_record_incident",
      manager,
      w.id,
      "Follow-up call made",
      false,
      true,
      null,
      null,
    );
  });

  it("deletes waivers three years after signing and keeps newer ones", async () => {
    const old = await create();
    const fresh = await create();
    expect(
      Number(
        await val(
          sql`SELECT extract(year FROM age(retain_until, signed_at)) FROM public.dab_waivers WHERE id = ${fresh.id}`,
        ),
      ),
    ).toBe(3);
    await sql`UPDATE public.dab_waivers SET retain_until = now() - interval '1 day' WHERE id = ${old.id}`;
    expect(Number(await rpc(sql, "dab_waiver_purge_expired"))).toBeGreaterThanOrEqual(1);
    expect(await val(sql`SELECT count(*)::int FROM public.dab_waivers WHERE id = ${old.id}`)).toBe(
      0,
    );
    expect(
      await val(sql`SELECT count(*)::int FROM public.dab_waivers WHERE id = ${fresh.id}`),
    ).toBe(1);
  });

  it("is only callable by the server", async () => {
    for (const fn of [
      "dab_waiver_create(uuid,jsonb)",
      "dab_waiver_claim(uuid,uuid,text)",
      "dab_waiver_get(uuid,uuid)",
      "dab_waiver_list(uuid,integer,timestamptz,text)",
      "dab_waiver_purge_expired()",
    ]) {
      expect(
        await val(
          sql`SELECT has_function_privilege('authenticated', ${"public." + fn}, 'EXECUTE')`,
        ),
      ).toBe(false);
      expect(
        await val(sql`SELECT has_function_privilege('anon', ${"public." + fn}, 'EXECUTE')`),
      ).toBe(false);
    }
    expect(
      await val(sql`SELECT has_table_privilege('authenticated', 'public.dab_waivers', 'SELECT')`),
    ).toBe(false);
  });
});
