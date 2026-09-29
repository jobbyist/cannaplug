// Supabase Edge Function: paypal-subscription
//
// Backs the /subscribe/admin-api landing page ("Shopify Admin API Integration - Basic",
// USD 25/month billed monthly or USD 19/month billed annually, excluding tax).
// Configure in Project Settings -> Edge Functions -> Secrets:
//
//   PAYPAL_CLIENT_ID          (required)
//   PAYPAL_CLIENT_SECRET      (required)
//   PAYPAL_ENV                (optional) "sandbox" (default) or "live"
//   PAYPAL_PLAN_ID_MONTHLY    (required for checkout) PayPal plan id, USD 25 / 1 MONTH
//   PAYPAL_PLAN_ID_ANNUAL     (required for checkout) PayPal plan id, USD 228 / 1 YEAR
//   SITE_URL                  (optional) e.g. https://cannaplug.lovable.app — PayPal return origin
//   PAYPAL_SETUP_TOKEN        (optional) enables the one-off "setup" action below
//   PAYPAL_TAX_PERCENTAGE     (optional) tax added on top of the plan price, e.g. "15"
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Actions (POST JSON):
//   { action: "create", interval: "monthly" | "annual" } -> { approveUrl, subscriptionId }
//   { action: "confirm", subscriptionId }                -> { status, interval }
//   { action: "setup" } + header x-setup-token           -> creates the PayPal product and
//                                                          both plans, returns their ids to
//                                                          store as the PLAN_ID secrets.
//
// Deploy with: supabase functions deploy paypal-subscription --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-setup-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SERVICE_NAME = "Shopify Admin API Integration - Basic";
const PRICES = { monthly: "25.00", annual: "228.00" } as const; // 19 x 12
type Interval = keyof typeof PRICES;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const apiBase = () =>
  Deno.env.get("PAYPAL_ENV") === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

async function accessToken(): Promise<string> {
  const id = Deno.env.get("PAYPAL_CLIENT_ID");
  const secret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  if (!id || !secret) throw new Error("PayPal credentials are not configured");
  const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status})`);
  return (await res.json()).access_token;
}

async function paypal(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[paypal]", path, res.status, JSON.stringify(data));
    throw new Error(`PayPal request failed (${res.status})`);
  }
  return data;
}

const planId = (interval: Interval) =>
  Deno.env.get(interval === "monthly" ? "PAYPAL_PLAN_ID_MONTHLY" : "PAYPAL_PLAN_ID_ANNUAL");

function siteOrigin(req: Request): string {
  const configured = Deno.env.get("SITE_URL");
  if (configured) return configured.replace(/\/+$/, "");
  const origin = req.headers.get("origin");
  if (origin && /^https?:\/\//.test(origin)) return origin;
  throw new Error("SITE_URL is not configured");
}

async function setup() {
  const token = await accessToken();
  const product = await paypal(token, "/v1/catalogs/products", {
    method: "POST",
    body: JSON.stringify({
      name: SERVICE_NAME,
      description: "Custom development service by Cannaplug Pty Ltd",
      type: "SERVICE",
      category: "SOFTWARE",
    }),
  });
  const tax = Deno.env.get("PAYPAL_TAX_PERCENTAGE");
  const plans: Record<string, string> = {};
  for (const interval of ["monthly", "annual"] as const) {
    const plan = await paypal(token, "/v1/billing/plans", {
      method: "POST",
      body: JSON.stringify({
        product_id: product.id,
        name: `${SERVICE_NAME} (${interval})`,
        status: "ACTIVE",
        billing_cycles: [
          {
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0,
            frequency: {
              interval_unit: interval === "monthly" ? "MONTH" : "YEAR",
              interval_count: 1,
            },
            pricing_scheme: { fixed_price: { value: PRICES[interval], currency_code: "USD" } },
          },
        ],
        payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
        ...(tax ? { taxes: { percentage: tax, inclusive: false } } : {}),
      }),
    });
    plans[interval] = plan.id;
  }
  return {
    productId: product.id,
    PAYPAL_PLAN_ID_MONTHLY: plans.monthly,
    PAYPAL_PLAN_ID_ANNUAL: plans.annual,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  try {
    if (body.action === "setup") {
      const expected = Deno.env.get("PAYPAL_SETUP_TOKEN");
      if (!expected || req.headers.get("x-setup-token") !== expected) {
        return json({ error: "Forbidden" }, 403);
      }
      return json(await setup());
    }

    if (body.action === "create") {
      const interval = body.interval;
      if (interval !== "monthly" && interval !== "annual") {
        return json({ error: "Invalid billing interval" }, 400);
      }
      const plan = planId(interval);
      if (!plan) return json({ error: "Subscriptions are not available yet" }, 503);

      const origin = siteOrigin(req);
      const token = await accessToken();
      const sub = await paypal(token, "/v1/billing/subscriptions", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          plan_id: plan,
          custom_id: interval,
          application_context: {
            brand_name: "Cannaplug Pty Ltd",
            user_action: "SUBSCRIBE_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url: `${origin}/subscribe/admin-api?interval=${interval}`,
            cancel_url: `${origin}/subscribe/admin-api?cancelled=1`,
          },
        }),
      });
      const approve = (sub.links ?? []).find((l: { rel: string }) => l.rel === "approve");
      if (!approve) return json({ error: "PayPal did not return an approval link" }, 502);
      return json({ approveUrl: approve.href, subscriptionId: sub.id });
    }

    if (body.action === "confirm") {
      const id = body.subscriptionId;
      if (typeof id !== "string" || !/^I-[A-Z0-9]{6,40}$/.test(id)) {
        return json({ error: "Invalid subscription id" }, 400);
      }
      const token = await accessToken();
      const sub = await paypal(token, `/v1/billing/subscriptions/${id}`);
      const interval = (["monthly", "annual"] as const).find((i) => planId(i) === sub.plan_id);
      if (!interval) return json({ error: "Unrecognised subscription plan" }, 400);

      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
      );
      const { error } = await supabase.from("admin_api_subscriptions").upsert(
        {
          paypal_subscription_id: sub.id,
          billing_interval: interval,
          paypal_plan_id: sub.plan_id,
          status: sub.status,
          payer_email: sub.subscriber?.email_address ?? null,
          payer_name:
            [sub.subscriber?.name?.given_name, sub.subscriber?.name?.surname]
              .filter(Boolean)
              .join(" ") || null,
          start_time: sub.start_time ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "paypal_subscription_id" },
      );
      if (error) {
        console.error("[paypal-subscription] db", error.message);
        return json({ error: "Could not record subscription" }, 500);
      }
      return json({ status: sub.status, interval });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("[paypal-subscription]", err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
