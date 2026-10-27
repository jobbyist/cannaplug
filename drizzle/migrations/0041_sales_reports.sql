-- 27 Oct 2026: sales reporting for the overview, the Reports tab and a daily email to managers.
--   * _sales_report(from, to): POS and online sales for South African calendar days [from, to]. Read-only, and it
--     carries no customer names, contact details, ID or health data: totals, products, categories, payment
--     methods, staff names for the till, and receipt / order numbers.
--     POS: sales that are not voided (gross), refunds made in the period, net = gross - refunds.
--     Online: orders that are paid (confirmed onwards, not cancelled); unpaid and cancelled orders are counted apart.
--   * sales_report(actor, from, to): any staff member (the overview already shows sales to budtenders).
--   * sales_report_email(actor, day, key): a manager sends one day's report to managers and admins now (audited,
--     idempotent). sales_daily_report_enqueue(day): the same for the scheduler, once per day (dedupe key).
--   * pg_cron 'cannaplug-daily-sales' at 05:00 UTC (07:00 SAST) sends yesterday's report.
--   * pos_sales joins the realtime publication so the overview updates the moment a till sale is made (staff can
--     already read pos_sales through RLS; customers cannot). orders is already published.

CREATE INDEX IF NOT EXISTS pos_sales_created_idx ON public.pos_sales (created_at DESC);
CREATE INDEX IF NOT EXISTS pos_refunds_created_idx ON public.pos_refunds (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_created_idx ON public.orders (created_at DESC);

CREATE OR REPLACE FUNCTION public._sales_report(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c_tz constant text := 'Africa/Johannesburg';
  v_start timestamptz;
  v_end timestamptz;
  v_pos jsonb;
  v_online jsonb;
  v_daily jsonb;
  v_hourly jsonb;
  v_tenders jsonb;
  v_methods jsonb;
  v_products jsonb;
  v_categories jsonb;
  v_cashiers jsonb;
  v_recent jsonb;
  v_pos_net numeric;
  v_online_total numeric;
  v_tx integer;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN
    RAISE EXCEPTION 'invalid_input: choose a date range of up to 400 days';
  END IF;
  v_start := (p_from::timestamp AT TIME ZONE c_tz);
  v_end := ((p_to + 1)::timestamp AT TIME ZONE c_tz);

  -- POS
  WITH s AS (
    SELECT * FROM public.pos_sales WHERE created_at >= v_start AND created_at < v_end
  ), r AS (
    SELECT * FROM public.pos_refunds WHERE created_at >= v_start AND created_at < v_end
  )
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM s WHERE status <> 'voided'),
    'gross', COALESCE((SELECT sum(total) FROM s WHERE status <> 'voided'), 0),
    'refunds', COALESCE((SELECT sum(amount) FROM r), 0),
    'refund_count', (SELECT count(*) FROM r),
    'voided_count', (SELECT count(*) FROM s WHERE status = 'voided'),
    'voided_total', COALESCE((SELECT sum(total) FROM s WHERE status = 'voided'), 0)
  ) INTO v_pos;
  v_pos := v_pos || jsonb_build_object('net', (v_pos->>'gross')::numeric - (v_pos->>'refunds')::numeric);
  v_pos_net := (v_pos->>'net')::numeric;

  -- Online
  WITH o AS (
    SELECT * FROM public.orders WHERE created_at >= v_start AND created_at < v_end
  )
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM o WHERE status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')),
    'total', COALESCE((SELECT sum(total_rand) FROM o WHERE status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')), 0),
    'delivery_fees', COALESCE((SELECT sum(delivery_fee_rand) FROM o WHERE status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')), 0),
    'awaiting_count', (SELECT count(*) FROM o WHERE status = 'awaiting_payment'),
    'awaiting_total', COALESCE((SELECT sum(total_rand) FROM o WHERE status = 'awaiting_payment'), 0),
    'cancelled_count', (SELECT count(*) FROM o WHERE status = 'cancelled'),
    'pickup_count', (SELECT count(*) FROM o WHERE delivery_method = 'collection'
                       AND status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed'))
  ) INTO v_online;
  v_online_total := (v_online->>'total')::numeric;
  v_tx := (v_pos->>'count')::integer + (v_online->>'count')::integer;

  -- Per day (SAST)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('day', d.day, 'pos', d.pos, 'online', d.online) ORDER BY d.day), '[]'::jsonb)
  INTO v_daily FROM (
    SELECT g::date AS day,
      COALESCE((SELECT sum(total) FROM public.pos_sales x WHERE x.status <> 'voided'
                AND (x.created_at AT TIME ZONE c_tz)::date = g::date), 0)
      - COALESCE((SELECT sum(amount) FROM public.pos_refunds x
                  WHERE (x.created_at AT TIME ZONE c_tz)::date = g::date), 0) AS pos,
      COALESCE((SELECT sum(total_rand) FROM public.orders x
                WHERE x.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
                AND (x.created_at AT TIME ZONE c_tz)::date = g::date), 0) AS online
    FROM generate_series(p_from, p_to, interval '1 day') g
  ) d;

  -- Per hour of day across the range (SAST)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('hour', h.hour, 'pos', h.pos, 'online', h.online, 'count', h.n) ORDER BY h.hour), '[]'::jsonb)
  INTO v_hourly FROM (
    SELECT hr AS hour,
      COALESCE((SELECT sum(total) FROM public.pos_sales x WHERE x.status <> 'voided'
                AND x.created_at >= v_start AND x.created_at < v_end
                AND extract(hour FROM x.created_at AT TIME ZONE c_tz) = hr), 0) AS pos,
      COALESCE((SELECT sum(total_rand) FROM public.orders x
                WHERE x.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
                AND x.created_at >= v_start AND x.created_at < v_end
                AND extract(hour FROM x.created_at AT TIME ZONE c_tz) = hr), 0) AS online,
      (SELECT count(*) FROM public.pos_sales x WHERE x.status <> 'voided'
         AND x.created_at >= v_start AND x.created_at < v_end
         AND extract(hour FROM x.created_at AT TIME ZONE c_tz) = hr)
      + (SELECT count(*) FROM public.orders x
         WHERE x.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
         AND x.created_at >= v_start AND x.created_at < v_end
         AND extract(hour FROM x.created_at AT TIME ZONE c_tz) = hr) AS n
    FROM generate_series(0, 23) hr
  ) h;

  -- Till payments by method (sales not voided)
  SELECT COALESCE(jsonb_object_agg(t.method, t.amount), '{}'::jsonb) INTO v_tenders FROM (
    SELECT tn.method, sum(tn.amount) AS amount
    FROM public.pos_tenders tn JOIN public.pos_sales s ON s.id = tn.sale_id
    WHERE s.status <> 'voided' AND s.created_at >= v_start AND s.created_at < v_end
    GROUP BY tn.method) t;

  -- Online payments by method (paid orders)
  SELECT COALESCE(jsonb_object_agg(m.method, m.amount), '{}'::jsonb) INTO v_methods FROM (
    SELECT COALESCE(o.payment_method, 'unknown') AS method, sum(o.total_rand) AS amount
    FROM public.orders o
    WHERE o.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
      AND o.created_at >= v_start AND o.created_at < v_end
    GROUP BY 1) m;

  -- Products (both channels; till refunds taken off)
  WITH lines AS (
    SELECT i.product_id, i.product_name, (i.quantity - i.refunded_quantity) AS qty,
           i.unit_price_rand * (i.quantity - i.refunded_quantity) AS revenue, 'pos' AS channel
    FROM public.pos_sale_items i JOIN public.pos_sales s ON s.id = i.sale_id
    WHERE s.status <> 'voided' AND s.created_at >= v_start AND s.created_at < v_end
    UNION ALL
    SELECT i.product_id, i.product_name, i.quantity, i.unit_price_rand * i.quantity, 'online'
    FROM public.order_items i JOIN public.orders o ON o.id = i.order_id
    WHERE o.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
      AND o.created_at >= v_start AND o.created_at < v_end
  ), by_product AS (
    SELECT l.product_name AS name, max(p.category) AS category, sum(l.qty) AS qty, sum(l.revenue) AS revenue,
           sum(l.revenue) FILTER (WHERE l.channel = 'pos') AS pos, sum(l.revenue) FILTER (WHERE l.channel = 'online') AS online
    FROM lines l LEFT JOIN public.products p ON p.id = l.product_id
    WHERE l.qty > 0
    GROUP BY l.product_name
  )
  SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('name', name, 'category', category, 'qty', qty, 'revenue', revenue,
                                                  'pos', COALESCE(pos, 0), 'online', COALESCE(online, 0))
                               ORDER BY revenue DESC, name)
              FROM (SELECT * FROM by_product ORDER BY revenue DESC, name LIMIT 25) t), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('category', category, 'qty', qty, 'revenue', revenue) ORDER BY revenue DESC)
              FROM (SELECT COALESCE(category, 'Other') AS category, sum(qty) AS qty, sum(revenue) AS revenue
                    FROM by_product GROUP BY 1) c), '[]'::jsonb)
  INTO v_products, v_categories;

  -- Till sales by staff member
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', c.name, 'count', c.n, 'total', c.total) ORDER BY c.total DESC), '[]'::jsonb)
  INTO v_cashiers FROM (
    SELECT COALESCE(NULLIF(btrim(pr.full_name), ''), 'Staff member') AS name, count(*) AS n, sum(s.total) AS total
    FROM public.pos_sales s LEFT JOIN public.profiles pr ON pr.id = s.cashier_id
    WHERE s.status <> 'voided' AND s.created_at >= v_start AND s.created_at < v_end
    GROUP BY 1) c;

  -- Latest 15 transactions, both channels (receipt / order number only)
  SELECT COALESCE(jsonb_agg(t ORDER BY t.at DESC), '[]'::jsonb) INTO v_recent FROM (
    SELECT * FROM (
      SELECT 'pos' AS channel, s.receipt_number AS ref, s.total AS amount, s.status, s.created_at AS at,
             (SELECT string_agg(DISTINCT tn.method, '+') FROM public.pos_tenders tn WHERE tn.sale_id = s.id) AS method
      FROM public.pos_sales s WHERE s.created_at >= v_start AND s.created_at < v_end
      UNION ALL
      SELECT 'online', o.order_number, o.total_rand, o.status, o.created_at, o.payment_method
      FROM public.orders o WHERE o.created_at >= v_start AND o.created_at < v_end
    ) u ORDER BY at DESC LIMIT 15) t;

  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to, 'generated_at', now(),
    'total', v_pos_net + v_online_total,
    'transactions', v_tx,
    'average_sale', CASE WHEN v_tx > 0 THEN round((COALESCE((v_pos->>'gross')::numeric, 0) + v_online_total) / v_tx, 2) ELSE 0 END,
    'pos', v_pos, 'online', v_online,
    'daily', v_daily, 'hourly', v_hourly,
    'pos_tenders', v_tenders, 'online_methods', v_methods,
    'products', v_products, 'categories', v_categories,
    'cashiers', v_cashiers, 'recent', v_recent);
END;
$$;
REVOKE ALL ON FUNCTION public._sales_report(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sales_report(date, date) TO service_role;

CREATE OR REPLACE FUNCTION public.sales_report(p_actor uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender'::public.app_role);
  RETURN public._sales_report(p_from, p_to);
END;
$$;
REVOKE ALL ON FUNCTION public.sales_report(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_report(uuid, date, date) TO service_role;

-- The email data: totals, payment methods and the top 5 products. No customer data.
CREATE OR REPLACE FUNCTION public._sales_report_email_data(p_day date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'day', p_day, 'total', r->'total', 'transactions', r->'transactions', 'average_sale', r->'average_sale',
    'pos', r->'pos', 'online', r->'online', 'pos_tenders', r->'pos_tenders', 'online_methods', r->'online_methods',
    'products', COALESCE((SELECT jsonb_agg(e) FROM (SELECT e FROM jsonb_array_elements(r->'products') e LIMIT 5) t), '[]'::jsonb),
    'cashiers', r->'cashiers')
  FROM (SELECT public._sales_report(p_day, p_day) AS r) x;
$$;
REVOKE ALL ON FUNCTION public._sales_report_email_data(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sales_report_email_data(date) TO service_role;

-- Scheduler: yesterday's report (SAST) to managers and admins, at most once per day.
CREATE OR REPLACE FUNCTION public.sales_daily_report_enqueue(p_day date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_day date := COALESCE(p_day, (now() AT TIME ZONE 'Africa/Johannesburg')::date - 1);
  v_n integer;
BEGIN
  v_n := public.notification_enqueue_staff('staff_daily_sales', public._sales_report_email_data(v_day),
                                           'daily_sales:' || v_day::text, 'manager'::public.app_role);
  IF v_n > 0 THEN
    PERFORM public._audit(NULL, 'daily_sales_report_queued', 'sales_report', NULL,
      jsonb_build_object('day', v_day, 'recipients', v_n));
  END IF;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.sales_daily_report_enqueue(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_daily_report_enqueue(date) TO service_role;

-- A manager sends one day's report to managers and admins now (e.g. at closing time).
CREATE OR REPLACE FUNCTION public.sales_report_email(p_actor uuid, p_day date, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_n integer;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);
  v_cached := public._idem_begin('sales_report_email', p_actor, p_idempotency_key, jsonb_build_object('day', p_day));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_day IS NULL OR p_day > (now() AT TIME ZONE 'Africa/Johannesburg')::date
     OR p_day < (now() AT TIME ZONE 'Africa/Johannesburg')::date - 400 THEN
    RAISE EXCEPTION 'invalid_input: choose a day in the last 400 days';
  END IF;
  v_n := public.notification_enqueue_staff('staff_daily_sales', public._sales_report_email_data(p_day),
                                           'sales_report:' || p_day::text || ':' || p_idempotency_key,
                                           'manager'::public.app_role);
  PERFORM public._audit(p_actor, 'sales_report_emailed', 'sales_report', NULL,
    jsonb_build_object('day', p_day, 'recipients', v_n));
  v_response := jsonb_build_object('day', p_day, 'recipients', v_n);
  RETURN public._idem_finish('sales_report_email', p_actor, p_idempotency_key, v_response);
END;
$$;
REVOKE ALL ON FUNCTION public.sales_report_email(uuid, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_report_email(uuid, date, text) TO service_role;

DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cannaplug-daily-sales';
    PERFORM cron.schedule('cannaplug-daily-sales', '0 5 * * *', $c$SELECT public.sales_daily_report_enqueue(NULL)$c$);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'pos_sales') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pos_sales;
  END IF;
END;
$$;
