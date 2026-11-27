-- 27 Nov 2026: saved baskets and cart reminder emails for members who leave items behind.
--   * member_carts: one row per member (their basket, saved from the site whenever it changes; restored on any device).
--     It also holds the member's cart-email opt-out (unsubscribe token + unsubscribed_at), so the opt-out outlives the basket.
--     Only product ids and quantities are stored; names and prices are read live when an email is built.
--   * cart_save / cart_get: service role only, called from the server with the signed-in member's id.
--   * cart_reminders_enqueue(), every 10 minutes, 08:00-20:00 South African time only:
--       email 1: the basket has been idle for 2 hours.
--       email 2: 24 hours after email 1, if the basket is still there and unchanged for 22 hours: includes the incentive
--                (double Plug points on a collection order placed within 48 hours of that email).
--     At most two emails per basket and a new cycle only if the last cart email was 3+ days ago. Nothing is sent to staff,
--     deactivated or deleted accounts, unsubscribed members, or members who ordered after they last touched the basket.
--     Category marketing, tier low (the daily email budget serves orders and payments first). Legal basis recorded on every
--     email: existing customer, with a one-click opt-out (POPIA s69(3)); the privacy policy says so.
--   * Incentive: accrue_order_loyalty (the Black Friday double-points rule) also doubles points when _cart_bonus_applies(order).
--     The points ledger itself is unchanged; Black Friday and the cart bonus do not stack.
--   * Email tiers: cart_reminder is low (3). order_abandoned (the unpaid-order reminder) drops from high to normal (2).
--   * Rollback: supabase/rollbacks/20261127007000_cart_reminders_rollback.sql.

CREATE TABLE IF NOT EXISTS public.member_carts (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 50),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reminder_1_at timestamptz,
  reminder_2_at timestamptz,
  unsubscribe_token text NOT NULL DEFAULT substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 48),
  unsubscribed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS member_carts_token_uq ON public.member_carts (unsubscribe_token);
CREATE INDEX IF NOT EXISTS member_carts_idle_idx ON public.member_carts (updated_at) WHERE items <> '[]'::jsonb;
ALTER TABLE public.member_carts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_carts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.member_carts TO service_role;
COMMENT ON TABLE public.member_carts IS 'A member''s saved basket (product ids and quantities) and their cart-email opt-out. Written by the server only.';

CREATE OR REPLACE FUNCTION public.cart_save(p_user_id uuid, p_items jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_items jsonb;
  v_old public.member_carts;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'cart_invalid: user required'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'cart_invalid: items must be a list of at most 50 lines';
  END IF;
  -- One line per product, quantities clamped to 1..999; anything that is not a product id and a whole quantity is refused.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', pid, 'quantity', LEAST(q, 999)) ORDER BY pid), '[]'::jsonb)
  INTO v_items
  FROM (SELECT (e->>'product_id')::uuid AS pid, sum(GREATEST((e->>'quantity')::integer, 1)) AS q
        FROM jsonb_array_elements(p_items) e GROUP BY 1) s;

  SELECT * INTO v_old FROM public.member_carts WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.member_carts (user_id, items) VALUES (p_user_id, v_items)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN;
  END IF;
  IF v_old.items = v_items THEN RETURN; END IF;  -- nothing changed: the idle clock keeps running
  UPDATE public.member_carts
  SET items = v_items, updated_at = now(),
      -- A fresh basket starts a new reminder cycle only if the last cart email was 3+ days ago.
      reminder_1_at = CASE WHEN v_old.items = '[]'::jsonb AND v_items <> '[]'::jsonb
                            AND COALESCE(v_old.reminder_2_at, v_old.reminder_1_at, '-infinity') < now() - interval '3 days'
                           THEN NULL ELSE v_old.reminder_1_at END,
      reminder_2_at = CASE WHEN v_old.items = '[]'::jsonb AND v_items <> '[]'::jsonb
                            AND COALESCE(v_old.reminder_2_at, v_old.reminder_1_at, '-infinity') < now() - interval '3 days'
                           THEN NULL ELSE v_old.reminder_2_at END
  WHERE user_id = p_user_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cart_get(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT COALESCE((SELECT items FROM public.member_carts WHERE user_id = p_user_id), '[]'::jsonb) $$;

CREATE OR REPLACE FUNCTION public.cart_unsubscribe(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{48}$' THEN RAISE EXCEPTION 'invalid_token'; END IF;
  UPDATE public.member_carts SET unsubscribed_at = now() WHERE unsubscribe_token = p_token AND unsubscribed_at IS NULL;
  RETURN jsonb_build_object('status', 'unsubscribed');
END;
$$;

-- Double points for a collection order placed within 48 hours of the second cart email.
CREATE OR REPLACE FUNCTION public._cart_bonus_applies(p_order_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.orders o JOIN public.member_carts c ON c.user_id = o.user_id
    WHERE o.id = p_order_id AND c.reminder_2_at IS NOT NULL
      AND o.created_at >= c.reminder_2_at AND o.created_at < c.reminder_2_at + interval '48 hours');
$$;

CREATE OR REPLACE FUNCTION public.cart_reminders_enqueue(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_hour integer := extract(hour FROM p_now AT TIME ZONE 'Africa/Johannesburg');
  r record;
  v_stage integer;
  v_lines jsonb;
  v_subtotal numeric;
  v_more integer;
  v_n integer := 0;
BEGIN
  IF v_hour < 8 OR v_hour >= 20 THEN RETURN 0; END IF;  -- no cart emails overnight
  PERFORM pg_advisory_xact_lock(hashtext('cart_reminders_enqueue'));
  FOR r IN
    SELECT c.*, u.email, COALESCE(NULLIF(btrim(p.first_name), ''), 'there') AS first_name
    FROM public.member_carts c
    JOIN auth.users u ON u.id = c.user_id
    LEFT JOIN public.profiles p ON p.id = c.user_id
    WHERE c.items <> '[]'::jsonb AND c.unsubscribed_at IS NULL AND u.email IS NOT NULL
      AND NOT public._is_staff(c.user_id)
      AND NOT EXISTS (SELECT 1 FROM public.profiles p2
                      WHERE p2.id = c.user_id AND (p2.deactivated_at IS NOT NULL OR p2.deleted_at IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.user_id = c.user_id AND o.created_at > c.updated_at)
      AND (
        (c.reminder_1_at IS NULL AND c.updated_at <= now() - interval '2 hours'
           AND COALESCE(c.reminder_2_at, '-infinity') < now() - interval '3 days')
        OR (c.reminder_1_at IS NOT NULL AND c.reminder_2_at IS NULL
            AND c.reminder_1_at <= now() - interval '24 hours' AND c.reminder_1_at > now() - interval '72 hours'
            AND c.updated_at <= now() - interval '22 hours')
      )
    ORDER BY c.updated_at
    LIMIT 200
    FOR UPDATE OF c SKIP LOCKED
  LOOP
    v_stage := CASE WHEN r.reminder_1_at IS NULL THEN 1 ELSE 2 END;
    -- Live names and prices; products that are no longer on sale are left out.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('name', x.name, 'quantity', x.q, 'price_rand', x.price_rand,
                                                  'unit', x.unit) ORDER BY x.name) FILTER (WHERE x.rn <= 5), '[]'::jsonb),
           COALESCE(sum(x.price_rand * x.q), 0), GREATEST(count(*) - 5, 0)
    INTO v_lines, v_subtotal, v_more
    FROM (SELECT pr.name, pr.price_rand, pr.unit, (e->>'quantity')::integer AS q,
                 row_number() OVER (ORDER BY pr.name) AS rn
          FROM jsonb_array_elements(r.items) e
          JOIN public.products pr ON pr.id = (e->>'product_id')::uuid AND pr.is_active) x;
    IF jsonb_array_length(v_lines) = 0 THEN CONTINUE; END IF;

    IF public.notification_enqueue(
         'email', 'cart_reminder', r.email, r.user_id, 'marketing',
         jsonb_build_object('stage', v_stage, 'first_name', r.first_name, 'items', v_lines, 'more', v_more,
                            'subtotal_rand', v_subtotal, 'unsubscribe_token', r.unsubscribe_token,
                            'unsubscribe_kind', 'cart', 'consent', 'true', 'consent_basis', 'existing_customer_opt_out'),
         'cart:' || r.user_id::text || ':' || extract(epoch FROM now())::bigint::text || ':' || v_stage::text) IS NOT NULL THEN
      UPDATE public.member_carts
      SET reminder_1_at = CASE WHEN v_stage = 1 THEN now() ELSE reminder_1_at END,
          reminder_2_at = CASE WHEN v_stage = 2 THEN now() ELSE reminder_2_at END
      WHERE user_id = r.user_id;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._email_tier(p_template text)
RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_template IN ('staff_id_review', 'id_submitted') THEN 0
    WHEN p_template IN ('promo_announcement', 'journal_digest', 'cart_reminder') THEN 3
    WHEN p_template IN ('staff_low_stock', 'back_in_stock', 'id_expiring', 'newsletter_welcome',
                        'contact_form_ack', 'id_approved', 'member_import_invite', 'order_abandoned') THEN 2
    ELSE 1
  END;
$$;

DO $f$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.cart_save(uuid, jsonb)', 'public.cart_get(uuid)', 'public.cart_unsubscribe(text)',
    'public._cart_bonus_applies(uuid)', 'public.cart_reminders_enqueue(timestamptz)', 'public._email_tier(text)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$f$;

DO $mig$
DECLARE
  v_sig constant text := 'public.accrue_order_loyalty(uuid)';
  v_old constant text := 'v_double := v_points > 0 AND public.bfcm_campaign_active(v_order.created_at)';
  v_new constant text := 'v_double := v_points > 0 AND (public.bfcm_campaign_active(v_order.created_at) OR public._cart_bonus_applies(v_order.id) /* cart_bonus */)';
  v_def text := pg_get_functiondef(v_sig::regprocedure);
BEGIN
  IF position('/* cart_bonus */' IN v_def) = 0 THEN
    IF position(v_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'cart_reminders: double-points line not found in accrue_order_loyalty';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('cart-reminders', '*/10 * * * *', 'SELECT public.cart_reminders_enqueue()');
  END IF;
END
$mig$;
