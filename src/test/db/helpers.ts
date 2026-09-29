import postgres from "postgres";

/**
 * Real-PostgreSQL test helpers. Tests are skipped unless TEST_DATABASE_URL is set
 * (see scripts/test-db.sh). Functions are invoked exactly as the server does: as SECURITY DEFINER
 * RPCs with an explicit actor id.
 */
export const DB_URL = process.env["TEST_DATABASE_URL"];

export type Sql = postgres.Sql;

export function connect(max = 40): Sql {
  if (!DB_URL) throw new Error("TEST_DATABASE_URL is not set");
  return postgres(DB_URL, { max, onnotice: () => {}, connect_timeout: 10 });
}

let seq = 0;
export const uid = () => crypto.randomUUID();
export const key = (label = "k") =>
  `${label}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

export type Role = "customer" | "budtender" | "manager" | "admin";

export async function mkUser(sql: Sql, role: Role): Promise<string> {
  const id = uid();
  await sql`INSERT INTO auth.users (id, email) VALUES (${id}, ${`${role}-${id}@test.local`})`;
  await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${id}, ${role}::public.app_role)
            ON CONFLICT DO NOTHING`;
  return id;
}

export async function mkProduct(sql: Sql, price = 50): Promise<string> {
  const id = uid();
  await sql`INSERT INTO public.products (id, slug, name, category, price_rand)
            VALUES (${id}, ${`p-${id}`}, ${`Product ${id.slice(0, 6)}`}, 'Flower', ${price})`;
  return id;
}

/** Call a public.* RPC. Arguments are sent as typed parameters; objects are sent as jsonb. */
export async function rpc<T = any>(sql: Sql, name: string, ...args: unknown[]): Promise<T> {
  const params = args.map((a) =>
    a !== null && typeof a === "object" && !(a instanceof Date) ? sql.json(a as any) : (a as any),
  );
  const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await sql.unsafe(`SELECT public.${name}(${placeholders}) AS r`, params);
  return rows[0]!["r"] as T;
}

export type Outcome<T = any> =
  { ok: true; value: T } | { ok: false; message: string; code?: string };

export async function attempt<T = any>(p: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await p };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e), code: e?.code };
  }
}

export const failedWith = (o: Outcome, prefix: string) => !o.ok && o.message.startsWith(prefix);

export async function receive(
  sql: Sql,
  manager: string,
  productId: string,
  quantity: number,
  batchCode = `B-${Math.random().toString(36).slice(2, 8)}`,
  expiresAt: Date | null = null,
): Promise<string> {
  const r = await rpc(
    sql,
    "receive_stock",
    manager,
    productId,
    batchCode,
    quantity,
    expiresAt,
    null,
    null,
    key("rcv"),
  );
  return r.batch_id as string;
}

export async function mkSession(
  sql: Sql,
  manager: string,
  cashier: string,
  float = 500,
): Promise<{ drawerId: string; sessionId: string }> {
  const d = await rpc(
    sql,
    "pos_upsert_drawer",
    manager,
    null,
    `Till ${uid().slice(0, 8)}`,
    "Test",
    true,
  );
  const s = await rpc(sql, "pos_open_session", cashier, d.drawer_id, float, key("open"));
  return { drawerId: d.drawer_id, sessionId: s.session_id };
}

export const cash = (amount: number | string) => ({ method: "cash", amount: String(amount) });
export const card = (amount: number | string, reference: string) => ({
  method: "card",
  amount: String(amount),
  reference,
});

export function sell(
  sql: Sql,
  cashier: string,
  sessionId: string,
  items: { product_id: string; quantity: number; [k: string]: unknown }[],
  tenders: unknown[],
  opts: { customer?: string | null; idem?: string } = {},
) {
  return rpc(
    sql,
    "pos_complete_sale",
    cashier,
    sessionId,
    items,
    tenders,
    opts.customer ?? null,
    opts.idem ?? key("sale"),
  );
}

/** Cross-checks every batch counter against the ledger and reservation tables. */
export async function assertInventoryConsistent(sql: Sql): Promise<void> {
  const bad = await sql`
    SELECT b.id, b.qty_on_hand, b.qty_held,
           COALESCE((SELECT SUM(l.quantity_delta) FROM public.inventory_ledger l WHERE l.batch_id = b.id), 0)::int AS ledger_sum,
           COALESCE((SELECT SUM(r.quantity) FROM public.stock_reservations r WHERE r.batch_id = b.id AND r.status = 'held'), 0)::int AS held_sum
    FROM public.inventory_batches b
    WHERE b.qty_on_hand <> COALESCE((SELECT SUM(l.quantity_delta) FROM public.inventory_ledger l WHERE l.batch_id = b.id), 0)
       OR b.qty_held <> COALESCE((SELECT SUM(r.quantity) FROM public.stock_reservations r WHERE r.batch_id = b.id AND r.status = 'held'), 0)
       OR b.qty_on_hand < 0 OR b.qty_held < 0 OR b.qty_held > b.qty_on_hand`;
  if (bad.length)
    throw new Error(`inventory counters diverged from ledger: ${JSON.stringify(bad)}`);
}

export async function stockOf(sql: Sql, productId: string) {
  const [row] =
    await sql`SELECT on_hand, held, available, consumed FROM public.inventory_availability WHERE product_id = ${productId}`;
  return row as { on_hand: number; held: number; available: number; consumed: number };
}

/** First column of the first row (count(*), sum(...), ...). */
export async function val<T = any>(q: PromiseLike<readonly unknown[]>): Promise<T> {
  const rows = (await q) as Record<string, unknown>[];
  return Object.values(rows[0] ?? {})[0] as T;
}
