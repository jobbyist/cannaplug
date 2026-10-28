import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { FetchLike } from "@/lib/payments/provider";
import { paypalFromEnv } from "@/lib/payments/paypal";
import { handlePayPalSubscriptionEvent } from "./paypal-subscription";

const nodeFetch: FetchLike = async (u, i) => {
  const r = await fetch(u, i as RequestInit);
  return { ok: r.ok, status: r.status, text: () => r.text() };
};

/** Returns null for events that are not about the Shopify subscription (the shop flow handles those). */
export function processPayPalSubscriptionEvent(raw: string, headers: Headers) {
  return handlePayPalSubscriptionEvent(
    {
      cfg: paypalFromEnv(process.env),
      fetchFn: nodeFetch,
      async recordSale(a) {
        const { error } = await supabaseAdmin.rpc("billing_paypal_sale", {
          p_event: a.event,
          p_subscription_id: a.subscriptionId,
          p_payment_id: a.paymentId,
          p_sale_id: a.saleId,
          p_amount_cents: a.amountCents,
          p_currency: a.currency,
        });
        if (error) throw new Error(error.message);
      },
      async subscriptionEvent(a) {
        const { error } = await supabaseAdmin.rpc("billing_paypal_subscription_event", {
          p_subscription_id: a.subscriptionId,
          p_event: a.event,
          p_event_id: a.eventId,
        });
        if (error) throw new Error(error.message);
      },
    },
    raw,
    headers,
  );
}
