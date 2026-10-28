import { assertRole } from "@/lib/admin-data.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sastDay, addDays } from "@/lib/sales-report-logic";
import { payfastFromEnv } from "./payfast";
import { fetchTransactionHistory, parseHistory } from "./payfast-api";
import { PAYOUT_SCHEDULE, summariseAccount, type PayfastAccountSummary } from "./payfast-account";
import type { FetchLike } from "./provider";

export type PayfastAccountView =
  | { status: "not_configured" }
  | { status: "needs_passphrase" }
  | { status: "unavailable"; fetchedAt: string }
  | ({
      status: "ok";
      mode: "live" | "sandbox";
      fetchedAt: string;
      schedule: typeof PAYOUT_SCHEDULE;
      /** Our order numbers for the transactions shown (PayFast's m_payment_id is our transaction id). */
      orderNumbers: Record<string, string>;
    } & PayfastAccountSummary);

const nodeFetch: FetchLike = async (u, i) => {
  const r = await fetch(u, i as RequestInit);
  return { ok: r.ok, status: r.status, text: () => r.text() };
};

// The panel refreshes every minute per open tab; PayFast is asked at most every 30 seconds per server instance.
let cache: { at: number; view: PayfastAccountView } | null = null;
const CACHE_MS = 30_000;

export async function loadPayfastAccount(
  env: Record<string, string | undefined> = process.env,
  fetchFn: FetchLike = nodeFetch,
  now: Date = new Date(),
): Promise<PayfastAccountView> {
  const cfg = payfastFromEnv(env);
  if (!cfg) return { status: "not_configured" };
  if (!cfg.passphrase) return { status: "needs_passphrase" };
  const today = sastDay(now);
  const from = addDays(today, -30);
  try {
    let rows = parseHistory(
      await fetchTransactionHistory(cfg, fetchFn, { from, to: today, limit: 1000 }, now),
    );
    // A quiet month: look further back for the latest balance.
    if (rows.length === 0)
      rows = parseHistory(
        await fetchTransactionHistory(
          cfg,
          fetchFn,
          { from: addDays(today, -365), to: today, limit: 1000 },
          now,
        ),
      );
    const summary = summariseAccount(rows, today, from);
    return {
      status: "ok",
      mode: cfg.sandbox ? "sandbox" : "live",
      fetchedAt: now.toISOString(),
      schedule: PAYOUT_SCHEDULE,
      orderNumbers: {},
      ...summary,
    };
  } catch (err) {
    console.warn(
      "[payfast-account] history unavailable",
      err instanceof Error ? err.message : "error",
    );
    return { status: "unavailable", fetchedAt: now.toISOString() };
  }
}

/** Managers and admins only. */
export async function getPayfastAccount(userId: string): Promise<PayfastAccountView> {
  await assertRole(userId, "manager");
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.view;
  const view = await loadPayfastAccount();
  if (view.status === "ok") {
    const ids = [...new Set(view.recent.map((r) => r.transactionId))].filter((id) =>
      /^[0-9a-f-]{36}$/i.test(id),
    );
    if (ids.length) {
      const { data: txs } = await supabaseAdmin
        .from("payment_transactions")
        .select("id,order_id")
        .in("id", ids);
      const orderIds = [...new Set((txs ?? []).map((t) => t.order_id))];
      const { data: orders } = orderIds.length
        ? await supabaseAdmin.from("orders").select("id,order_number").in("id", orderIds)
        : { data: [] as { id: string; order_number: string }[] };
      const num = new Map((orders ?? []).map((o) => [o.id, o.order_number]));
      for (const t of txs ?? []) {
        const n = num.get(t.order_id);
        if (n) view.orderNumbers[t.id] = n;
      }
    }
  }
  cache = { at: Date.now(), view };
  return view;
}
