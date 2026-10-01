import { writeFileSync } from "node:fs";
import { ANON, API, PASSWORD, RUN_FILE, SERVICE, sql } from "./db";

/**
 * Runs once before the live suite: fresh users for THIS run (member, other member, manager), and a
 * known product/stock baseline. Everything else (orders, addresses, wishlist, points) belongs to those
 * fresh users, so the suite can be re-run against the same stack without a reset.
 */
async function createUser(email: string, name: string, role: "customer" | "manager") {
  const res = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE || ANON,
      authorization: `Bearer ${SERVICE}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: name },
    }),
  });
  if (!res.ok) throw new Error(`could not create ${email}: ${res.status} ${await res.text()}`);
  const id = ((await res.json()) as { id: string }).id;
  sql(
    `insert into public.user_roles (user_id, role) values ('${id}', '${role}'::public.app_role) on conflict do nothing;`,
  );
  return id;
}

export default async function globalSetup() {
  if (!SERVICE || !ANON)
    throw new Error(
      "Source /tmp/live.env first (ANON_KEY / SERVICE_ROLE_KEY) — see scripts/live-stack/README.md",
    );
  const stamp = Date.now().toString(36);
  const run = {
    member: `member-${stamp}@live.test`,
    other: `other-${stamp}@live.test`,
    manager: `manager-${stamp}@live.test`,
  };
  await createUser(run.member, "Mia Member", "customer");
  await createUser(run.other, "Omar Other", "customer");
  const manager = await createUser(run.manager, "Manny Manager", "manager");

  sql(`
    insert into public.products (slug, name, category, subcategory, price_rand, unit, is_active, sort_order) values
      ('live-blue-gelato','Live Blue Gelato','Flower','Greenhouse',100,'per gram',true,1),
      ('live-sour-og','Live Sour OG','Flower','Greenhouse',150,'per gram',true,2),
      ('live-sold-out','Live Sold-Out Edible','Edibles',null,60,'each',true,3)
    on conflict (slug) do update set is_active = true, price_rand = excluded.price_rand;`);
  for (const slug of ["live-blue-gelato", "live-sour-og"]) {
    const have = Number(
      sql(
        `select coalesce(sum(b.qty_on_hand - b.qty_held),0) from public.inventory_batches b join public.products p on p.id=b.product_id where p.slug='${slug}'`,
      ),
    );
    if (have < 80)
      sql(
        `select public.receive_stock('${manager}', (select id from public.products where slug='${slug}'), 'LIVE-${slug}-${stamp}', 200, null, null, null, 'live-stock-${slug}-${stamp}');`,
      );
  }
  // the sold-out product must really be out of stock
  if (
    Number(
      sql(
        `select coalesce(sum(b.qty_on_hand),0) from public.inventory_batches b join public.products p on p.id=b.product_id where p.slug='live-sold-out'`,
      ),
    ) !== 0
  )
    throw new Error("live-sold-out unexpectedly has stock");
  writeFileSync(RUN_FILE, JSON.stringify(run));
}
