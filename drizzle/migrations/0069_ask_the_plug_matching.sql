-- 31 Oct 2026: Ask The Plug, production matching (spec "Question Flow, Matching Logic & Stock Guardrails").
-- The quiz and the AI chat read products ONLY through plug_match_candidates, which applies the hard filters in the
-- database at the moment of the request (no cache):
--   1. active and sold online;
--   2. live availability (inventory_availability: on hand minus held, unexpired batches) at or above a safety buffer;
--   3. not marked as needing a medical practitioner's recommendation (new products.requires_recommendation);
--   4. the requested categories.
-- Safety buffer: a product needs at least `buffer_default` units (default 2) to be offered. Fast sellers, products
-- that sold at least `fast_seller_units_7d` units in the last 7 days (default 10, online paid orders + till sales net
-- of refunds and voids), need `buffer_fast` units (default 4), because their last units can go at the till while a
-- member is still reading the card. Managers change the three numbers in /admin → Settings (plug_settings_set).
-- plug_match_events: what was matched and what happened (answers, product ids, outcome). No user id, no personal data.
-- A Reserve that finds the product sold out raises a staff alert naming the product to recount (one per product,
-- counted over 24 hours, archived when a day passes without another).
-- Every function is SECURITY DEFINER, search_path='', service role only. No DELETE in this file.

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS requires_recommendation boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.products.requires_recommendation IS
  'Needs a valid medical practitioner recommendation: never recommended by Ask The Plug.';

CREATE TABLE IF NOT EXISTS public.plug_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  buffer_default integer NOT NULL DEFAULT 2 CHECK (buffer_default BETWEEN 1 AND 50),
  buffer_fast integer NOT NULL DEFAULT 4 CHECK (buffer_fast BETWEEN 1 AND 100),
  fast_seller_units_7d integer NOT NULL DEFAULT 10 CHECK (fast_seller_units_7d BETWEEN 1 AND 10000),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buffer_fast >= buffer_default)
);
INSERT INTO public.plug_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.plug_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plug_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.plug_settings TO service_role;

CREATE TABLE IF NOT EXISTS public.plug_match_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('match', 'another', 'reserve_ok', 'reserve_stock_fail', 'chat_reply_replaced')),
  outcome text NOT NULL CHECK (outcome IN ('matched', 'relaxed_strain', 'relaxed_budget', 'empty', 'ok', 'sold_out', 'replaced')),
  answers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object' AND length(answers::text) <= 400),
  product_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(product_ids) <= 10)
);
CREATE INDEX IF NOT EXISTS plug_match_events_recent_idx ON public.plug_match_events (created_at DESC);
CREATE INDEX IF NOT EXISTS plug_match_events_fail_idx ON public.plug_match_events (kind, created_at DESC)
  WHERE kind = 'reserve_stock_fail';
ALTER TABLE public.plug_match_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plug_match_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.plug_match_events TO service_role;

-- Units sold per product in the last 7 days (paid online orders + till sales net of refunds; voids excluded).
CREATE OR REPLACE FUNCTION public._plug_units_7d()
RETURNS TABLE (product_id uuid, units integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT x.product_id, sum(x.qty)::integer FROM (
    SELECT i.product_id, (i.quantity - COALESCE(i.refunded_quantity, 0)) AS qty
      FROM public.pos_sale_items i JOIN public.pos_sales s ON s.id = i.sale_id
     WHERE s.status <> 'voided' AND s.created_at >= now() - interval '7 days'
    UNION ALL
    SELECT i.product_id, i.quantity
      FROM public.order_items i JOIN public.orders o ON o.id = i.order_id
     WHERE o.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
       AND o.created_at >= now() - interval '7 days'
  ) x
  WHERE x.product_id IS NOT NULL
  GROUP BY x.product_id;
$$;

CREATE OR REPLACE FUNCTION public.plug_match_candidates(p_categories text[] DEFAULT NULL)
RETURNS TABLE (
  id uuid, name text, category text, subcategory text, strain_type text, price_rand numeric,
  regular_price_rand numeric, unit text, image_path text, is_featured boolean, sort_order integer,
  available integer, units_7d integer, fast_seller boolean, buffer integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH s AS (SELECT * FROM public.plug_settings WHERE id),
       v AS (SELECT * FROM public._plug_units_7d())
  SELECT p.id, p.name, p.category, p.subcategory, p.strain_type, p.price_rand, p.regular_price_rand, p.unit,
         p.image_path, p.is_featured, p.sort_order, a.available,
         COALESCE(v.units, 0) AS units_7d,
         COALESCE(v.units, 0) >= s.fast_seller_units_7d AS fast_seller,
         CASE WHEN COALESCE(v.units, 0) >= s.fast_seller_units_7d THEN s.buffer_fast ELSE s.buffer_default END
  FROM public.products p
  JOIN public.inventory_availability a ON a.product_id = p.id
  CROSS JOIN s
  LEFT JOIN v ON v.product_id = p.id
  WHERE p.is_active AND p.sell_online AND NOT p.requires_recommendation
    AND p.price_rand > 0
    AND (p_categories IS NULL OR p.category = ANY (p_categories))
    AND a.available >= GREATEST(
          CASE WHEN COALESCE(v.units, 0) >= s.fast_seller_units_7d THEN s.buffer_fast ELSE s.buffer_default END, 1);
$$;

CREATE OR REPLACE FUNCTION public.plug_settings_set(
  p_actor uuid, p_buffer_default integer, p_buffer_fast integer, p_fast_units integer, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_old public.plug_settings;
  v_response jsonb;
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager');
  IF p_buffer_default IS NULL OR p_buffer_default NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'invalid_input: the safety buffer must be 1 to 50 units';
  END IF;
  IF p_buffer_fast IS NULL OR p_buffer_fast NOT BETWEEN p_buffer_default AND 100 THEN
    RAISE EXCEPTION 'invalid_input: the fast-seller buffer must be at least the normal buffer (up to 100)';
  END IF;
  IF p_fast_units IS NULL OR p_fast_units NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'invalid_input: a fast seller must sell 1 to 10000 units a week';
  END IF;
  v_cached := public._idem_begin('plug_settings_set', p_actor, p_idempotency_key,
    jsonb_build_object('d', p_buffer_default, 'f', p_buffer_fast, 'u', p_fast_units));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  SELECT * INTO v_old FROM public.plug_settings WHERE id FOR UPDATE;
  UPDATE public.plug_settings SET buffer_default = p_buffer_default, buffer_fast = p_buffer_fast,
         fast_seller_units_7d = p_fast_units, updated_by = p_actor, updated_at = now()
   WHERE id;
  PERFORM public._audit(p_actor, 'plug_settings_set', 'plug_settings', NULL,
    jsonb_build_object('before', jsonb_build_object('buffer_default', v_old.buffer_default,
                         'buffer_fast', v_old.buffer_fast, 'fast_seller_units_7d', v_old.fast_seller_units_7d),
                       'after', jsonb_build_object('buffer_default', p_buffer_default, 'buffer_fast', p_buffer_fast,
                         'fast_seller_units_7d', p_fast_units)));
  v_response := jsonb_build_object('buffer_default', p_buffer_default, 'buffer_fast', p_buffer_fast,
                                   'fast_seller_units_7d', p_fast_units);
  RETURN public._idem_finish('plug_settings_set', p_actor, p_idempotency_key, v_response);
END;
$$;

-- Telemetry for the stock guardrails. Append-only and anonymous by design (no actor is stored, so no personal data);
-- the server is the only caller and passes only quiz answers (fixed keys) and product ids.
CREATE OR REPLACE FUNCTION public.plug_match_log(
  p_kind text, p_outcome text, p_answers jsonb, p_product_ids uuid[]
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_pid uuid;
  v_name text;
  v_count integer;
  r record;
BEGIN
  IF p_answers IS NOT NULL AND EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_answers) k
       WHERE k NOT IN ('experience', 'format', 'vibe', 'strain', 'budget', 'relaxed')) THEN
    RAISE EXCEPTION 'invalid_input: unknown answer key';
  END IF;
  INSERT INTO public.plug_match_events (kind, outcome, answers, product_ids)
  VALUES (p_kind, p_outcome, COALESCE(p_answers, '{}'::jsonb), COALESCE(p_product_ids, '{}'))
  RETURNING id INTO v_id;

  IF p_kind = 'reserve_stock_fail' THEN
    FOREACH v_pid IN ARRAY COALESCE(p_product_ids, '{}') LOOP
      SELECT name INTO v_name FROM public.products WHERE id = v_pid;
      IF v_name IS NULL THEN CONTINUE; END IF;
      SELECT count(*) INTO v_count FROM public.plug_match_events e
       WHERE e.kind = 'reserve_stock_fail' AND v_pid = ANY (e.product_ids) AND e.created_at > now() - interval '24 hours';
      PERFORM public._team_alert_sync('alert:plug-stock:' || v_pid::text, v_count, 'alert', 'manager',
        left('Recount: ' || v_name, 120),
        left('Ask The Plug offered ' || v_name || ' but it had sold out when a member tapped Reserve ('
             || public._plural(v_count, 'time', 'times') || ' in 24 hours). The shelf and the system disagree: '
             || 'recount it and receive any delivery into the POS.', 1000));
    END LOOP;
  END IF;
  -- Archive recount alerts that have had no new failure for a day.
  FOR r IN SELECT t.source_key FROM public.team_notifications t
            WHERE t.source_key LIKE 'alert:plug-stock:%' AND t.status = 'published' LOOP
    IF NOT EXISTS (SELECT 1 FROM public.plug_match_events e
                    WHERE e.kind = 'reserve_stock_fail' AND e.created_at > now() - interval '24 hours'
                      AND substr(r.source_key, 18)::uuid = ANY (e.product_ids)) THEN
      PERFORM public._team_alert_sync(r.source_key, 0, 'alert', 'manager', 'Recount', 'Cleared');
    END IF;
  END LOOP;
  RETURN v_id;
END;
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._plug_units_7d()',
    'public.plug_match_candidates(text[])',
    'public.plug_settings_set(uuid, integer, integer, integer, text)',
    'public.plug_match_log(text, text, jsonb, uuid[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
