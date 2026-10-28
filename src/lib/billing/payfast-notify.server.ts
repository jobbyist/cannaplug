import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { BillingService } from "@/lib/billing";
import type { FetchLike } from "@/lib/payments/provider";
import { billingPayfastFromEnv, handleBillingNotify } from "./payfast-notify";

const nodeFetch: FetchLike = async (u, i) => {
  const r = await fetch(u, i as RequestInit);
  return { ok: r.ok, status: r.status, text: () => r.text() };
};

export function processBillingNotify(
  service: BillingService,
  raw: string,
  headers: Headers,
  sourceIp: string | null,
) {
  return handleBillingNotify(
    {
      cfg: billingPayfastFromEnv(process.env),
      fetchFn: nodeFetch,
      async recordPayment(a) {
        const { data, error } = await supabaseAdmin.rpc("billing_record_payment", {
          p_slug: a.slug,
          p_provider: "payfast",
          p_provider_payment_id: a.paymentId,
          p_status: a.status,
          p_amount_cents: a.amountCents,
          p_currency: "ZAR",
          p_item_name: a.itemName,
        });
        if (error) throw new Error(error.message);
        return { recorded: (data as { recorded?: boolean } | null)?.recorded === true };
      },
    },
    service,
    raw,
    headers,
    sourceIp,
  );
}
