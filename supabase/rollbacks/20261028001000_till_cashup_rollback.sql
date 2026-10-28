-- Rollback for 20261028001000_till_cashup: the original close (no expenses or deposit), the original session guard
-- and the original sales report come back; the expense table and the cash-up columns are dropped.
-- Refused while any till expense or recorded deposit exists, because that cash-up history would be lost.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pos_session_expenses)
     OR EXISTS (SELECT 1 FROM public.pos_sessions WHERE cash_deposited > 0) THEN
    RAISE EXCEPTION 'rollback_blocked: till expenses or deposits exist; keep this migration or export them first';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.pos_add_expense(uuid, uuid, numeric, text, text, text);
DROP FUNCTION IF EXISTS public.pos_void_expense(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.pos_close_session(uuid, uuid, numeric, numeric, text, text);
DROP TABLE IF EXISTS public.pos_session_expenses;
DROP FUNCTION IF EXISTS public._pos_expense_guard();

CREATE OR REPLACE FUNCTION public._pos_session_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.drawer_id IS DISTINCT FROM OLD.drawer_id
     OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.opening_float IS DISTINCT FROM OLD.opening_float THEN
    RAISE EXCEPTION 'pos_sessions identity/opening columns are immutable';
  END IF;
  IF OLD.status = 'closed' AND (
       NEW.status <> 'closed'
       OR NEW.closed_by IS DISTINCT FROM OLD.closed_by
       OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
       OR NEW.expected_cash IS DISTINCT FROM OLD.expected_cash
       OR NEW.actual_cash IS DISTINCT FROM OLD.actual_cash
       OR NEW.variance IS DISTINCT FROM OLD.variance
       OR NEW.tender_totals IS DISTINCT FROM OLD.tender_totals
       OR NEW.sales_count IS DISTINCT FROM OLD.sales_count
       OR NEW.close_note IS DISTINCT FROM OLD.close_note) THEN
    RAISE EXCEPTION 'a closed pos_session count is immutable';
  END IF;
  IF OLD.approval_status IN ('approved', 'rejected') AND NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    RAISE EXCEPTION 'session approval decision is final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.pos_close_session(
  p_actor uuid, p_session_id uuid, p_actual_cash numeric, p_note text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_role public.app_role;
  v_session public.pos_sessions;
  v_cash_sales numeric(10,2);
  v_cash_refunds numeric(10,2);
  v_expected numeric(10,2);
  v_variance numeric(10,2);
  v_totals jsonb;
  v_count integer;
  v_approval text;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  v_role := public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('pos_close_session', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_session_id, 'a', p_actual_cash, 'n', p_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_actual_cash IS NULL OR p_actual_cash < 0 OR p_actual_cash > 10000000
     OR p_actual_cash <> round(p_actual_cash, 2) THEN
    RAISE EXCEPTION 'invalid_amount: counted cash must be >= 0 with at most 2 decimals';
  END IF;

  -- Exclusive lock: waits for every in-flight sale (which hold FOR SHARE) to commit, and makes any
  -- later sale see status = closed. This is what makes expected cash exact.
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'session_closed'; END IF;
  IF v_session.opened_by <> p_actor AND public.role_level(v_role) < public.role_level('manager') THEN
    RAISE EXCEPTION 'session_not_yours';
  END IF;

  SELECT COALESCE(SUM(t.amount), 0) INTO v_cash_sales
  FROM public.pos_tenders t JOIN public.pos_sales s ON s.id = t.sale_id
  WHERE s.session_id = p_session_id AND t.method = 'cash' AND s.status <> 'voided';
  SELECT COALESCE(SUM(po.amount), 0) INTO v_cash_refunds
  FROM public.pos_refund_payouts po JOIN public.pos_refunds r ON r.id = po.refund_id
  WHERE r.session_id = p_session_id AND po.method = 'cash';

  v_expected := v_session.opening_float + v_cash_sales - v_cash_refunds;
  v_variance := p_actual_cash - v_expected;

  SELECT COUNT(*) INTO v_count FROM public.pos_sales WHERE session_id = p_session_id AND status <> 'voided';
  SELECT COALESCE(jsonb_object_agg(m.method, m.net), '{}'::jsonb) INTO v_totals
  FROM (
    SELECT x.method, SUM(x.amount) AS net FROM (
      SELECT t.method, t.amount FROM public.pos_tenders t JOIN public.pos_sales s ON s.id = t.sale_id
      WHERE s.session_id = p_session_id AND s.status <> 'voided'
      UNION ALL
      SELECT po.method, -po.amount FROM public.pos_refund_payouts po JOIN public.pos_refunds r ON r.id = po.refund_id
      WHERE r.session_id = p_session_id
    ) x GROUP BY x.method
  ) m;

  v_approval := CASE WHEN abs(v_variance) > public.pos_variance_tolerance() THEN 'pending' ELSE 'not_required' END;

  UPDATE public.pos_sessions
  SET status = 'closed', closed_by = p_actor,
      -- clock_timestamp(), not now(): now() is the transaction START, which can precede the last
      -- sale this close had to wait for. This is the real close instant, after the exclusive lock.
      closed_at = clock_timestamp(),
      expected_cash = v_expected, actual_cash = p_actual_cash, variance = v_variance,
      tender_totals = v_totals, sales_count = v_count, close_note = left(p_note, 500),
      approval_status = v_approval
  WHERE id = p_session_id;

  PERFORM public._audit(p_actor, 'pos_session_closed', 'pos_session', p_session_id,
    jsonb_build_object('expected_cash', v_expected, 'actual_cash', p_actual_cash, 'variance', v_variance,
                       'approval_status', v_approval, 'sales_count', v_count));
  v_response := jsonb_build_object('session_id', p_session_id, 'expected_cash', v_expected,
    'actual_cash', p_actual_cash, 'variance', v_variance, 'tender_totals', v_totals,
    'sales_count', v_count, 'approval_status', v_approval);
  RETURN public._idem_finish('pos_close_session', p_actor, p_idempotency_key, v_response);
END;
$$;

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

REVOKE ALL ON FUNCTION public._sales_report(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sales_report(date, date) TO service_role;
REVOKE ALL ON FUNCTION public.pos_close_session(uuid, uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_close_session(uuid, uuid, numeric, text, text) TO service_role;

ALTER TABLE public.pos_sessions
  DROP COLUMN IF EXISTS cash_sales,
  DROP COLUMN IF EXISTS cash_refunds,
  DROP COLUMN IF EXISTS expenses_total,
  DROP COLUMN IF EXISTS discounts_total,
  DROP COLUMN IF EXISTS cash_deposited,
  DROP COLUMN IF EXISTS float_carried;
