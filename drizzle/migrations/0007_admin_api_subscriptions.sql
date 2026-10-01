-- PayPal subscriptions for the "Shopify Admin API Integration - Basic" service.
-- Written only by the paypal-subscription edge function (service role); no client access.
CREATE TABLE IF NOT EXISTS public.admin_api_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paypal_subscription_id text NOT NULL UNIQUE,
  billing_interval text NOT NULL CHECK (billing_interval IN ('monthly', 'annual')),
  paypal_plan_id text NOT NULL,
  status text NOT NULL,
  payer_email text,
  payer_name text,
  start_time timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.admin_api_subscriptions TO service_role;
ALTER TABLE public.admin_api_subscriptions ENABLE ROW LEVEL SECURITY;
