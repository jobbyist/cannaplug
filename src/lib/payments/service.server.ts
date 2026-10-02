import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { ensureLiveFxRate } from "./fx.server";
import { createPayPalProvider, paypalFromEnv } from "./paypal";
import type { FetchLike, PaymentProvider, ProviderId } from "./provider";
import type { PaymentsDb, PaymentsDeps, TxView } from "./service";
import { createYocoProvider, yocoFromEnv } from "./yoco";

const TX_COLS =
  "id,order_id,provider,status,expected_amount,expected_currency,fx_rate,provider_ref,redirect_url";

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export function supabasePaymentsDb(): PaymentsDb {
  return {
    async initiate(a) {
      const r = unwrap(
        await supabaseAdmin.rpc("payment_initiate", {
          p_user_id: a.userId,
          p_order_id: a.orderId,
          p_provider: a.provider,
          p_mode: a.mode,
          p_merchant_id: a.merchantId,
          p_idempotency_key: a.key,
        }),
      ) as { transaction_id: string; order_number: string; reused: boolean };
      return r;
    },
    async getTx(id) {
      const { data, error } = await supabaseAdmin
        .from("payment_transactions")
        .select(TX_COLS)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as TxView | null;
    },
    async findPayPalTx(userId, ref) {
      const { data, error } = await supabaseAdmin
        .from("payment_transactions")
        .select(TX_COLS)
        .eq("user_id", userId)
        .eq("provider", "paypal")
        .eq("provider_ref", ref)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as TxView | null;
    },
    async attach(txId, ref, url) {
      unwrap(
        await supabaseAdmin.rpc("payment_attach_session", {
          p_transaction_id: txId,
          p_provider_ref: ref,
          p_redirect_url: url,
        }),
      );
    },
    async markFailed(txId, reason) {
      unwrap(
        await supabaseAdmin.rpc("payment_mark_failed", {
          p_transaction_id: txId,
          p_reason: reason,
        }),
      );
    },
    async apply(provider, e) {
      const r = unwrap(
        await supabaseAdmin.rpc("payments_apply_verified_event", {
          p_provider: provider,
          p_event_key: e.eventKey,
          p_event_type: e.eventType,
          p_payload: e.payload as Json,
          p_facts: e.facts as unknown as Json,
        }),
      ) as { status: string; outcome: string; replayed: boolean };
      return r;
    },
    async reject(provider, reason, ipHash, hint) {
      unwrap(
        await supabaseAdmin.rpc("webhook_reject", {
          p_provider: provider,
          p_reason: reason,
          p_ip_hash: ipHash,
          p_event_key_hint: hint,
        }),
      );
    },
  };
}

export const hashIp = (ip: string | null): string | null =>
  ip ? createHash("sha256").update(`cannaplug:${ip}`).digest("hex").slice(0, 32) : null;

const nodeFetch: FetchLike = async (u, i) => {
  const r = await fetch(u, i as RequestInit);
  return { ok: r.ok, status: r.status, text: () => r.text() };
};

export function configuredProviders(
  env: Record<string, string | undefined> = process.env,
): Partial<Record<ProviderId, PaymentProvider>> {
  const out: Partial<Record<ProviderId, PaymentProvider>> = {};
  const y = yocoFromEnv(env);
  if (y) out.yoco = createYocoProvider(y, nodeFetch);
  const p = paypalFromEnv(env);
  if (p) out.paypal = createPayPalProvider(p, nodeFetch);
  return out;
}

export function paymentsDeps(siteUrl: string): PaymentsDeps {
  return {
    db: supabasePaymentsDb(),
    providers: configuredProviders(),
    ensureFx: ensureLiveFxRate,
    siteUrl: (process.env["SITE_URL"] ?? siteUrl).trim(),
    warn: (m, e) => console.warn(`[payments] ${m}`, e instanceof Error ? e.message : e),
  };
}
