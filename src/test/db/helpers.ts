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

/**
 * Runs `fn` exactly as a signed-in browser client would: role `authenticated` with the JWT subject
 * set, so RLS policies and column grants apply (this is what PostgREST and Realtime evaluate).
 * The transaction commits; a thrown error aborts it and rejects.
 */
export async function asUser<T>(sql: Sql, userId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    await tx`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`;
    return fn(tx as unknown as Sql);
  })) as T;
}

/** Same, as `anon` (no subject). */
export async function asAnon<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE anon`;
    return fn(tx as unknown as Sql);
  })) as T;
}

/** Places an online order for `customer` (server-priced) and returns its id. */
export async function placeOrder(
  sql: Sql,
  customer: string,
  items: { product_id: string; quantity: number }[],
): Promise<{ orderId: string; total: number }> {
  const r = await rpc(
    sql,
    "create_online_order",
    customer,
    items,
    "Test",
    "0820000000",
    null,
    key("ord"),
    30,
  );
  return { orderId: r.order_id as string, total: Number(r.total) };
}

/** Walks an order through the real fulfilment state machine as staff. */
export async function advanceOrder(
  sql: Sql,
  staff: string,
  orderId: string,
  to: "confirmed" | "completed" | "cancelled",
): Promise<void> {
  const path =
    to === "completed" ? ["confirmed", "packing", "ready", "out_for_delivery", "completed"] : [to];
  for (const status of path)
    await rpc(sql, "transition_order_status", orderId, status, staff, null);
}

/** Gives `customer` exactly `points` loyalty points by completing a real order (1 point per R10). */
export async function earnPoints(
  sql: Sql,
  manager: string,
  customer: string,
  points: number,
): Promise<string> {
  const product = await mkProduct(sql, points * 10);
  await receive(sql, manager, product, 1);
  const { orderId } = await placeOrder(sql, customer, [{ product_id: product, quantity: 1 }]);
  await advanceOrder(sql, manager, orderId, "completed");
  return orderId;
}

export async function loyaltyOf(sql: Sql, userId: string) {
  const [row] = await sql`
    SELECT a.points_balance, a.lifetime_points, t.code AS tier
    FROM public.loyalty_accounts a LEFT JOIN public.loyalty_tiers t ON t.id = a.tier_id
    WHERE a.user_id = ${userId}`;
  return (row ?? null) as {
    points_balance: number;
    lifetime_points: number;
    tier: string | null;
  } | null;
}

/** Every account's cached balance must equal the sum of its ledger rows (and match balance_after). */
export async function assertLoyaltyConsistent(sql: Sql): Promise<void> {
  const bad = await sql`
    SELECT a.user_id, a.points_balance,
           COALESCE((SELECT SUM(t.points) FROM public.loyalty_transactions t WHERE t.user_id = a.user_id), 0)::int AS ledger_sum
    FROM public.loyalty_accounts a
    WHERE a.points_balance <> COALESCE((SELECT SUM(t.points) FROM public.loyalty_transactions t WHERE t.user_id = a.user_id), 0)`;
  if (bad.length) throw new Error(`loyalty balances diverged from ledger: ${JSON.stringify(bad)}`);
}
