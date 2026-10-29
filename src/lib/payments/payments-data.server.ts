import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { assertCheckoutOpen, commerceSuspended } from "@/lib/commerce-suspension.server";
import { friendlyMemberError } from "@/lib/member-logic";
import {
  PaymentError,
  confirmPayPalReturn,
  startPayment,
  type ReturnStatus,
  type StartedPayment,
} from "./service";
import { paymentsDeps } from "./service.server";
import { ensureLiveFxRate } from "./fx.server";
import { payfastConfigProblems, payfastFromEnv } from "./payfast";
import { parseEftDetails, type EftDetails } from "./eft";
import type { Json } from "@/integrations/supabase/types";
import type { ProviderId } from "./provider";

export type OnlineMethods = {
  /** PayFast: card, Instant EFT and the other methods on PayFast's hosted page (ZAR). */
  card: boolean;
  /** PayFast's payment window opens on our checkout (card, Instant EFT, Masterpass) instead of PayFast's site. */
  cardOnsite: boolean;
  paypal: boolean;
  /** Bank transfer details, once the owner has confirmed them; null hides the EFT option. */
  eft: EftDetails | null;
};

/** Providers whose credentials are configured (no database read). */
export function configuredOnlineProviders(env: Record<string, string | undefined> = process.env) {
  const payfast = payfastFromEnv(env);
  return {
    card: !!payfast,
    cardOnsite: !!payfast?.onsite,
    paypal:
      !!env["PAYPAL_CLIENT_ID"] &&
      !!env["PAYPAL_CLIENT_SECRET"] &&
      !!env["PAYPAL_WEBHOOK_ID"] &&
      !!env["PAYPAL_MERCHANT_ID"],
  };
}

export async function getEftDetails(): Promise<EftDetails | null> {
  const { data, error } = await supabaseAdmin
    .from("payment_settings")
    .select("value")
    .eq("key", "eft_bank_details")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return parseEftDetails(data?.value ?? null);
}

/** Which payment methods the storefront may offer. */
export async function availableOnlineMethods(): Promise<OnlineMethods> {
  // Checkout is suspended while the platform bill is unpaid: no method is offered until the payment lifts it.
  if (await commerceSuspended())
    return { card: false, cardOnsite: false, paypal: false, eft: null };
  return { ...configuredOnlineProviders(), eft: await getEftDetails() };
}

/**
 * Today's PayPal rate for showing a member roughly what PayPal will charge before they leave. Indicative:
 * the exact USD amount is fixed by `payment_initiate` from the rate current at that moment.
 */
export async function getPaypalRate(): Promise<{ zarPerUsd: number; validUntil: string } | null> {
  if (!configuredOnlineProviders().paypal) return null;
  try {
    await ensureLiveFxRate();
  } catch {
    return null;
  }
  const { data } = await supabaseAdmin
    .from("fx_rates")
    .select("rate,valid_until")
    .eq("base_currency", "ZAR")
    .eq("quote_currency", "USD")
    .gt("valid_until", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { zarPerUsd: Number(data.rate), validUntil: data.valid_until } : null;
}

export async function setEftDetails(
  userId: string,
  details: (EftDetails & { confirmed: true }) | null,
  key: string,
) {
  await assertRole(userId, "manager");
  const payload = details
    ? {
        bank: details.bank,
        account_holder: details.account_holder,
        account_type: details.account_type,
        account_number: details.account_number,
        branch_code: details.branch_code,
        confirmed_by_owner: details.confirmed,
      }
    : null;
  const { data, error } = await supabaseAdmin.rpc("payment_set_eft_details", {
    p_actor: userId,
    p_details: payload as unknown as Json,
    p_idempotency_key: key,
  });
  if (error) throw new Error(error.message);
  return data as unknown as { enabled: boolean };
}

const memberError = (err: unknown): Error =>
  err instanceof PaymentError ? err : friendlyMemberError(err);

export async function startMemberPayment(
  userId: string,
  orderId: string,
  provider: ProviderId,
  key: string,
  origin: string,
  buyerEmail: string | null = null,
): Promise<StartedPayment> {
  await assertCheckoutOpen();
  try {
    return await startPayment(paymentsDeps(origin), {
      userId,
      orderId,
      provider,
      key,
      buyerEmail,
    });
  } catch (err) {
    throw memberError(err);
  }
}

export async function confirmMemberPayPalReturn(
  userId: string,
  token: string,
  origin: string,
): Promise<ReturnStatus> {
  try {
    return await confirmPayPalReturn(paymentsDeps(origin), userId, token);
  } catch (err) {
    console.error("[payments] paypal return failed", err instanceof Error ? err.message : err);
    return "pending"; // never guess "paid": the webhook path will still settle it
  }
}

/** Member-visible status. Paid is only ever what the database recorded after a verified event. */
export async function memberPaymentStatus(userId: string, orderId: string) {
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("id,order_number,status,total_rand,payment_method")
    .eq("id", orderId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw friendlyMemberError(error);
  if (!order) return null;
  const { data: tx } = await supabaseAdmin
    .from("payment_transactions")
    .select("provider,status,expected_amount,expected_currency,created_at")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return {
    orderNumber: order.order_number,
    orderStatus: order.status,
    paid: order.status !== "awaiting_payment" && order.status !== "cancelled",
    total: Number(order.total_rand),
    payment: tx
      ? {
          provider: tx.provider,
          status: tx.status,
          amount: Number(tx.expected_amount),
          currency: tx.expected_currency,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Staff: manual EFT (manager+), payments overview, FX settings
// ---------------------------------------------------------------------------------------------

const eftKey = (orderId: string, ref: string, amount: number) =>
  createHash("sha256")
    .update(`eft:${orderId}:${ref.trim().toLowerCase()}:${amount.toFixed(2)}`)
    .digest("hex")
    .slice(0, 40);

const today = () => new Date().toISOString().slice(0, 10);

export async function submitEft(
  userId: string,
  orderId: string,
  bankReference: string,
  amount: number,
) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin.rpc("eft_submit", {
    p_actor: userId,
    p_order_id: orderId,
    p_bank_reference: bankReference.trim(),
    p_amount: amount,
    p_received_on: today(),
    p_note: null,
    p_idempotency_key: eftKey(orderId, bankReference, amount),
  });
  if (error) throw new Error(error.message);
  return data as { outcome: string; status: string; transaction_id: string; replayed?: boolean };
}

export async function approveEft(userId: string, transactionId: string) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin.rpc("eft_approve", {
    p_actor: userId,
    p_transaction_id: transactionId,
    p_idempotency_key: `approve:${transactionId}`,
  });
  if (error) throw new Error(error.message);
  return data as { outcome: string; status: string };
}

export async function rejectEft(userId: string, transactionId: string, reason: string) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin.rpc("eft_reject", {
    p_actor: userId,
    p_transaction_id: transactionId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function getPaymentsOverview(userId: string) {
  await assertRole(userId, "manager");
  const [txs, fx, settings, rejections] = await Promise.all([
    supabaseAdmin
      .from("payment_transactions")
      .select(
        "id,order_id,provider,status,mode,expected_amount,expected_currency,fx_rate,received_amount,received_currency,failure_reason,provider_ref,created_by,created_at,completed_at",
      )
      .order("created_at", { ascending: false })
      .limit(60),
    supabaseAdmin
      .from("fx_rates")
      .select("rate,source,set_by,created_at,valid_until")
      .eq("base_currency", "ZAR")
      .eq("quote_currency", "USD")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin.from("payment_settings").select("key,value"),
    supabaseAdmin
      .from("webhook_rejections")
      .select("id", { count: "exact", head: true })
      .gte("created_at", new Date(Date.now() - 86_400_000).toISOString()),
  ]);
  if (txs.error) throw new Error(txs.error.message);
  const orderIds = [...new Set((txs.data ?? []).map((t) => t.order_id))];
  const { data: orders } = orderIds.length
    ? await supabaseAdmin.from("orders").select("id,order_number").in("id", orderIds)
    : { data: [] as { id: string; order_number: string }[] };
  const numbers = new Map((orders ?? []).map((o) => [o.id, o.order_number]));
  const cfg = new Map((settings.data ?? []).map((r) => [r.key, r.value]));
  return {
    transactions: (txs.data ?? []).map((t) => ({
      ...t,
      order_number: numbers.get(t.order_id) ?? "",
    })),
    fx: fx.data ?? null,
    settings: {
      fxMode: cfg.get("fx_mode") === "manual" ? ("manual" as const) : ("live" as const),
      fxMarginPercent: Number(cfg.get("fx_margin_percent") ?? 4),
      eftThreshold: Number(cfg.get("eft_dual_control_threshold_rand") ?? 10000),
    },
    eft: parseEftDetails(cfg.get("eft_bank_details") ?? null),
    rejectionsLast24h: rejections.count ?? 0,
    configured: { ...configuredOnlineProviders() },
    /** PayFast misconfigurations, by variable name and rule only: never a value. */
    diagnostics: payfastConfigProblems(process.env),
  };
}

export async function updateFxSettings(
  userId: string,
  input: { mode: "live" | "manual"; marginPercent: number },
) {
  await assertRole(userId, "manager");
  if (!(input.marginPercent >= 0 && input.marginPercent <= 10))
    throw new Error("Margin must be between 0 and 10 percent");
  const rows = [
    { key: "fx_mode", value: input.mode, updated_by: userId, updated_at: new Date().toISOString() },
    {
      key: "fx_margin_percent",
      value: input.marginPercent,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
  ];
  const { error } = await supabaseAdmin
    .from("payment_settings")
    .upsert(rows, { onConflict: "key" });
  if (error) throw new Error(error.message);
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: "fx_settings_changed",
    entity_type: "payment_settings",
    entity_id: null,
    metadata: input,
  });
}

export async function setManualFxRate(userId: string, rate: number, validHours: number) {
  await assertRole(userId, "manager");
  const { error } = await supabaseAdmin.rpc("fx_set_rate", {
    p_actor: userId,
    p_base: "ZAR",
    p_quote: "USD",
    p_rate: rate,
    p_valid_hours: validHours,
    p_source: "manual (manager)",
  });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------------------------
// Audit viewer (manager+): structured, attributable events for admin, manager and POS actions
// ---------------------------------------------------------------------------------------------

export async function listAuditEvents(
  userId: string,
  filter: { actionPrefix?: string | undefined; limit?: number | undefined },
) {
  await assertRole(userId, "manager");
  let q = supabaseAdmin
    .from("audit_log")
    .select("id,actor_user_id,action,entity_type,entity_id,metadata,created_at")
    .order("id", { ascending: false })
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 300));
  if (filter.actionPrefix) q = q.like("action", `${filter.actionPrefix.replace(/[%_]/g, "")}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const ids = [
    ...new Set((data ?? []).map((r) => r.actor_user_id).filter((v): v is string => !!v)),
  ];
  const { data: profiles } = ids.length
    ? await supabaseAdmin.from("profiles").select("id,full_name").in("id", ids)
    : { data: [] as { id: string; full_name: string | null }[] };
  const names = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));
  return (data ?? []).map((r) => ({
    ...r,
    actor_name: r.actor_user_id ? (names.get(r.actor_user_id) ?? null) : null,
  }));
}
