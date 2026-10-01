// Seeds the LOCAL live-test stack: a member, a manager, a second member (isolation checks) and stock.
// Idempotent. Needs: SERVICE_ROLE_KEY, SUPABASE_URL (gateway) and psql access to the live DB.
import { execFileSync } from "node:child_process";

const URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const KEY = process.env.SERVICE_ROLE_KEY;
const PSQL = ["-X", "-q", "-At", "-h", "127.0.0.1", "-p", process.env.LIVE_PGPORT ?? "54330", "-U", "postgres", "-d", "live", "-v", "ON_ERROR_STOP=1"];
const psql = (sql) =>
  execFileSync("psql", PSQL, { input: sql, env: { ...process.env, PGPASSWORD: "" } }).toString().trim();

export const PASSWORD = "Live-test-pass-1!";
export const USERS = {
  member: { email: "member@live.test", name: "Mia Member", role: "customer" },
  other: { email: "other@live.test", name: "Omar Other", role: "customer" },
  manager: { email: "manager@live.test", name: "Manny Manager", role: "manager" },
};

async function ensureUser(u) {
  const res = await fetch(`${URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ email: u.email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: u.name } }),
  });
  if (res.ok) return (await res.json()).id;
  const id = psql(`select id from auth.users where email='${u.email}'`);
  if (!id) throw new Error(`could not create ${u.email}: ${res.status} ${await res.text()}`);
  return id;
}

const ids = {};
for (const [k, u] of Object.entries(USERS)) ids[k] = await ensureUser(u);
for (const [k, u] of Object.entries(USERS)) {
  psql(`insert into public.user_roles (user_id, role) values ('${ids[k]}', '${u.role}'::public.app_role) on conflict do nothing;`);
}
// Two active products with stock (idempotent by slug), received through the real inventory RPC.
psql(`
insert into public.products (slug, name, category, subcategory, price_rand, unit, is_active, sort_order)
values ('live-blue-gelato','Live Blue Gelato','Flower','Greenhouse',100,'per gram',true,1),
       ('live-sour-og','Live Sour OG','Flower','Greenhouse',150,'per gram',true,2),
       ('live-sold-out','Live Sold-Out Edible','Edibles',null,60,'each',true,3)
on conflict (slug) do update set is_active = true, price_rand = excluded.price_rand;
`);
for (const slug of ["live-blue-gelato", "live-sour-og"]) {
  const have = psql(`select coalesce(sum(b.qty_on_hand),0) from public.inventory_batches b join public.products p on p.id=b.product_id where p.slug='${slug}'`);
  if (Number(have) < 50)
    psql(`select public.receive_stock('${ids.manager}', (select id from public.products where slug='${slug}'), 'LIVE-${slug}-${Date.now()}', 100, null, null, null, 'live-seed-${slug}-${Date.now()}');`);
}
console.log(JSON.stringify({ ids, password: PASSWORD }));
