-- 26 Nov 2026: Black Friday + Cyber Monday 2026, and online orders before the ID is checked.
--   Owner decisions (26 Nov 2026):
--   (1) Every online order (collect in store) can be placed and paid before the member's ID has been checked by hand.
--       _require_verified_member now refuses only a member whose ID was rejected. Staff are still exempt. The ID is checked at
--       collection (the pickup option already says "Bring your ID").
--   (2) Black Friday + Cyber Monday: Fri 27 Nov 00:00 SAST to Mon 30 Nov 23:59 SAST.
--       * bfcm_campaign_active(at): the campaign window, in one place.
--       * Double loyalty points: accrue_order_loyalty doubles the points of an online (pickup) order placed in the window.
--       * Double Plug Back: plug_back_tubes_per_reward() is 5 tubes in the window and 10 otherwise (now STABLE, not IMMUTABLE).
--         Tubes already counted are kept; a free pre-roll spends whatever the rule is at that moment.
--       * Scheduled sales: scheduled_sales holds a sale that starts later. products_start_due_sales() puts each due sale on its
--         product (sale price, end time, online-only flag) and writes an audit row; pg_cron runs it every minute and the app calls
--         it just before pricing, like the end-of-sale sweep. The existing sweep ends each sale at sale_ends_at.
--       * schedule_black_friday_2026(): queues the campaign's sales by category and grade (idempotent):
--           in the shop and online, Fri 27 - Sun 29: Top Shelf flower 25% off, all accessories 20% off;
--           online only, Fri 27 - Mon 30: Entry Indoor flower R70/g, all edibles 20% off;
--           online only, Mon 30 only: Greendoor flower R55/g.
--         A product that is already on sale keeps its regular price as the base. A product whose price is already at or under
--         the campaign price is skipped. Products are not edited by this migration; they change when the sale starts.
--   No DROP and no DELETE of data. Every function: SECURITY DEFINER, search_path '', service role only, audit rows.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Online orders before the ID check
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._require_verified_member(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF public._is_staff(p_user_id) THEN
    RETURN;
  END IF;
  SELECT cv.status INTO v_status FROM public.customer_verification cv WHERE cv.user_id = p_user_id;
  IF v_status = 'rejected' THEN
    RAISE EXCEPTION 'verification_rejected: your ID could not be approved. Upload a new one to keep ordering';
  END IF;
  -- Every other state (none, pending, provisional, expired, verified) may order: the ID is checked at collection.
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The campaign window
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bfcm_campaign_active(p_at timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  -- Fri 27 Nov 2026 00:00 SAST up to, not including, Tue 1 Dec 00:00 SAST: the campaign closes at the end of Monday 30 Nov.
  SELECT p_at >= timestamptz '2026-11-27 00:00:00+02' AND p_at < timestamptz '2026-12-01 00:00:00+02'
$$;
REVOKE ALL ON FUNCTION public.bfcm_campaign_active(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bfcm_campaign_active(timestamptz) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Double Plug Back: 5 tubes in the window, 10 otherwise
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.plug_back_tubes_per_reward()
RETURNS integer LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE WHEN public.bfcm_campaign_active(now()) THEN 5 ELSE 10 END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Double loyalty points on online (pickup) orders placed in the window
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accrue_order_loyalty(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
  v_points integer;
  v_double boolean;
BEGIN
  PERFORM public._require_read_committed();
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('accrued', false, 'reason', 'order_not_found'); END IF;
  IF v_order.status <> 'completed' THEN RETURN jsonb_build_object('accrued', false, 'reason', 'not_completed'); END IF;
  -- Points are earned on what was actually paid for goods: after any redeemed points, and
  -- excluding the delivery fee.
  v_points := public._loyalty_points_for_amount(v_order.total_rand - v_order.delivery_fee_rand);
  -- Black Friday + Cyber Monday: double points on an online order for collection, by the day it was placed.
  v_double := v_points > 0 AND public.bfcm_campaign_active(v_order.created_at)
              AND public._order_is_pickup(v_order.delivery_method);
  IF v_double THEN v_points := v_points * 2; END IF;
  PERFORM public._referral_check(v_order.user_id);
  IF v_points <= 0 THEN RETURN jsonb_build_object('accrued', false, 'reason', 'no_points'); END IF;
  INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, order_id, points)
  VALUES (v_order.user_id, 'earn', 'order', v_order.id, v_order.id, v_points)
  ON CONFLICT (source_type, source_id) DO NOTHING;
  IF FOUND THEN
    RETURN jsonb_build_object('accrued', true, 'points', v_points, 'double', v_double);
  END IF;
  RETURN jsonb_build_object('accrued', false, 'reason', 'already_accrued');
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Scheduled sales
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scheduled_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign text NOT NULL CHECK (campaign ~ '^[a-z0-9_-]{3,60}$'),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  sale_price_rand numeric(10,2) NOT NULL CHECK (sale_price_rand > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  online_only boolean NOT NULL DEFAULT false,
  label text CHECK (label IS NULL OR length(label) <= 120),
  applied_at timestamptz,
  skipped_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (campaign, product_id, starts_at)
);
CREATE INDEX IF NOT EXISTS scheduled_sales_due_idx ON public.scheduled_sales (starts_at)
  WHERE applied_at IS NULL AND skipped_reason IS NULL;
ALTER TABLE public.scheduled_sales ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scheduled_sales FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.scheduled_sales TO service_role;
COMMENT ON TABLE public.scheduled_sales IS 'A sale that starts later. products_start_due_sales() puts it on the product at starts_at.';

CREATE OR REPLACE FUNCTION public.products_start_due_sales(p_actor uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer := 0;
  r record;
  v_base numeric(10,2);
  v_regular numeric(10,2);
  v_price numeric(10,2);
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM public._assert_staff(p_actor, 'budtender'::public.app_role);
  END IF;
  FOR r IN
    SELECT s.* FROM public.scheduled_sales s
    WHERE s.applied_at IS NULL AND s.skipped_reason IS NULL AND s.starts_at <= now()
    ORDER BY s.starts_at, s.id
    FOR UPDATE SKIP LOCKED
  LOOP
    IF r.ends_at <= now() THEN
      UPDATE public.scheduled_sales SET skipped_reason = 'already_over' WHERE id = r.id;
      CONTINUE;
    END IF;
    -- The regular price is the product's regular price when it is already on sale, otherwise its current price.
    SELECT COALESCE(p.regular_price_rand, p.price_rand), p.price_rand INTO v_base, v_price
    FROM public.products p WHERE p.id = r.product_id FOR UPDATE;
    IF NOT FOUND THEN
      UPDATE public.scheduled_sales SET skipped_reason = 'product_missing' WHERE id = r.id;
      CONTINUE;
    END IF;
    v_regular := v_base;
    IF r.sale_price_rand >= v_regular THEN
      UPDATE public.scheduled_sales SET skipped_reason = 'not_lower_than_regular' WHERE id = r.id;
      CONTINUE;
    END IF;
    UPDATE public.products
    SET price_rand = r.sale_price_rand, regular_price_rand = v_regular, sale_ends_at = r.ends_at,
        sale_online_only = r.online_only
    WHERE id = r.product_id;
    UPDATE public.scheduled_sales SET applied_at = now() WHERE id = r.id;
    INSERT INTO public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (p_actor, 'product_sale_started', 'product', r.product_id,
            jsonb_build_object('campaign', r.campaign, 'sale_price', r.sale_price_rand, 'regular_price', v_regular,
                               'sale_ends_at', r.ends_at, 'online_only', r.online_only, 'label', r.label,
                               'by', CASE WHEN p_actor IS NULL THEN 'scheduler' ELSE 'staff' END));
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.products_start_due_sales(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.products_start_due_sales(uuid) TO service_role;

DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cannaplug-start-sales';
    PERFORM cron.schedule('cannaplug-start-sales', '* * * * *', $c$SELECT public.products_start_due_sales(NULL)$c$);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. The campaign's sales (queued, not applied: each starts at its own time)
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_black_friday_2026()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_start constant timestamptz := timestamptz '2026-11-27 00:00:00+02';
  c_mon constant timestamptz := timestamptz '2026-11-30 00:00:00+02';
  c_sun_end constant timestamptz := timestamptz '2026-11-29 23:59:00+02';
  c_mon_end constant timestamptz := timestamptz '2026-11-30 23:59:00+02';
  v_total integer := 0;
  v_n integer;
BEGIN
  -- Top Shelf flower: 25% off, Fri to Sun.
  INSERT INTO public.scheduled_sales (campaign, product_id, sale_price_rand, starts_at, ends_at, online_only, label)
  SELECT 'bfcm-2026', p.id, round(COALESCE(p.regular_price_rand, p.price_rand) * 0.75, 2), c_start, c_sun_end, false, 'Top Shelf flower 25% off'
  FROM public.products p
  WHERE p.is_active AND p.category = 'Flower' AND lower(btrim(p.subcategory)) = 'top shelf'
  ON CONFLICT (campaign, product_id, starts_at) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- All accessories: 20% off, Fri to Sun.
  INSERT INTO public.scheduled_sales (campaign, product_id, sale_price_rand, starts_at, ends_at, online_only, label)
  SELECT 'bfcm-2026', p.id, round(COALESCE(p.regular_price_rand, p.price_rand) * 0.80, 2), c_start, c_sun_end, false, 'Accessories 20% off'
  FROM public.products p
  WHERE p.is_active AND p.category = 'Accessories'
  ON CONFLICT (campaign, product_id, starts_at) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- Entry Indoor flower: R70/g online, Fri to Mon.
  INSERT INTO public.scheduled_sales (campaign, product_id, sale_price_rand, starts_at, ends_at, online_only, label)
  SELECT 'bfcm-2026', p.id, 70.00, c_start, c_mon_end, true, 'Entry Indoor flower R70/g online'
  FROM public.products p
  WHERE p.is_active AND p.category = 'Flower' AND lower(btrim(p.subcategory)) = 'entry indoor'
  ON CONFLICT (campaign, product_id, starts_at) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- All edibles: 20% off online, Fri to Mon.
  INSERT INTO public.scheduled_sales (campaign, product_id, sale_price_rand, starts_at, ends_at, online_only, label)
  SELECT 'bfcm-2026', p.id, round(COALESCE(p.regular_price_rand, p.price_rand) * 0.80, 2), c_start, c_mon_end, true, 'Edibles 20% off online'
  FROM public.products p
  WHERE p.is_active AND p.category = 'Edibles'
  ON CONFLICT (campaign, product_id, starts_at) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- Cyber Monday: Greendoor flower R55/g online, Monday only.
  INSERT INTO public.scheduled_sales (campaign, product_id, sale_price_rand, starts_at, ends_at, online_only, label)
  SELECT 'bfcm-2026', p.id, 55.00, c_mon, c_mon_end, true, 'Cyber Monday: Greendoor flower R55/g online'
  FROM public.products p
  WHERE p.is_active AND p.category = 'Flower' AND lower(btrim(p.subcategory)) = 'greendoor'
  ON CONFLICT (campaign, product_id, starts_at) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  RETURN v_total;
END;
$$;
REVOKE ALL ON FUNCTION public.schedule_black_friday_2026() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_black_friday_2026() TO service_role;

SELECT public.schedule_black_friday_2026();
-- Anything already due when this migration is applied (after midnight) starts straight away.
SELECT public.products_start_due_sales(NULL);
