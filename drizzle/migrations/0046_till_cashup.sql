-- 28 Oct 2026: till cash-up that reconciles.
--   * pos_session_expenses: cash paid out of the till for store expenses during a session (category, description,
--     amount, who). Added and voided only through pos_add_expense / pos_void_expense while the session is open.
--     Staff can read them (RLS); no browser role can write.
--   * pos_close_session(actor, session, counted, deposited, note, key): expected cash now subtracts till expenses:
--       expected = opening float + cash taken - cash refunds - till expenses
--     Discounts are already off the sale totals (and so off the cash taken); the close records them so the cash-up
--     shows them. The cashier records the cash taken out for the bank deposit; what is left (counted - deposit) is
--     the float carried to the next session on that drawer. The close stores every figure and they are immutable.
--     The old five-argument close stays as a wrapper (deposit 0) so a deploy and this migration can land in any order.
--   * _sales_report: adds discounts, till expenses, deposits, variances and each closed session's cash-up, and
--     takes product revenue from what was really paid (line_total, after discounts).
--   No customer, ID or health data anywhere: expense descriptions are free text, so the UI warns against it.

-- 1. Expenses ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_session_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.pos_sessions(id) ON DELETE RESTRICT,
  amount numeric(10,2) NOT NULL CHECK (amount > 0 AND amount <= 100000),
  category text NOT NULL CHECK (category IN ('supplies', 'cleaning', 'transport', 'food', 'maintenance', 'stock', 'other')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 200),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 3 AND 200),
  CONSTRAINT pos_session_expenses_void_chk CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS pos_session_expenses_session_idx ON public.pos_session_expenses (session_id);
CREATE INDEX IF NOT EXISTS pos_session_expenses_created_idx ON public.pos_session_expenses (created_at DESC);

ALTER TABLE public.pos_session_expenses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_session_expenses FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pos_session_expenses TO service_role;
GRANT SELECT ON public.pos_session_expenses TO authenticated;
DROP POLICY IF EXISTS "staff read till expenses" ON public.pos_session_expenses;
CREATE POLICY "staff read till expenses" ON public.pos_session_expenses FOR SELECT TO authenticated
  USING ((SELECT public.has_at_least_role('budtender'::public.app_role)));

-- Backstop: an expense can only be written while its session is open, and only its void fields can change.
CREATE OR REPLACE FUNCTION public._pos_expense_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'till expenses are never deleted; void them instead';
  END IF;
  IF (SELECT status FROM public.pos_sessions WHERE id = NEW.session_id) IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'session_closed: expenses can only change while the till is open';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.category IS DISTINCT FROM OLD.category OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR OLD.voided_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a till expense can only be voided, once';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pos_session_expenses_guard ON public.pos_session_expenses;
CREATE TRIGGER pos_session_expenses_guard BEFORE INSERT OR UPDATE OR DELETE ON public.pos_session_expenses
  FOR EACH ROW EXECUTE FUNCTION public._pos_expense_guard();

-- 2. Cash-up columns on the session -----------------------------------------------------------------------------
ALTER TABLE public.pos_sessions
  ADD COLUMN IF NOT EXISTS cash_sales numeric(10,2),
  ADD COLUMN IF NOT EXISTS cash_refunds numeric(10,2),
  ADD COLUMN IF NOT EXISTS expenses_total numeric(10,2),
  ADD COLUMN IF NOT EXISTS discounts_total numeric(10,2),
  ADD COLUMN IF NOT EXISTS cash_deposited numeric(10,2) CHECK (cash_deposited IS NULL OR cash_deposited >= 0),
  ADD COLUMN IF NOT EXISTS float_carried numeric(10,2) CHECK (float_carried IS NULL OR float_carried >= 0);

-- The close is final: the new figures join the immutable set.
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
       OR NEW.close_note IS DISTINCT FROM OLD.close_note
       OR NEW.cash_sales IS DISTINCT FROM OLD.cash_sales
       OR NEW.cash_refunds IS DISTINCT FROM OLD.cash_refunds
       OR NEW.expenses_total IS DISTINCT FROM OLD.expenses_total
       OR NEW.discounts_total IS DISTINCT FROM OLD.discounts_total
       OR NEW.cash_deposited IS DISTINCT FROM OLD.cash_deposited
       OR NEW.float_carried IS DISTINCT FROM OLD.float_carried) THEN
    RAISE EXCEPTION 'a closed pos_session count is immutable';
  END IF;
  IF OLD.approval_status IN ('approved', 'rejected') AND NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    RAISE EXCEPTION 'session approval decision is final';
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Add / void an expense ----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_add_expense(
  p_actor uuid, p_session_id uuid, p_amount numeric, p_category text, p_description text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_role public.app_role;
  v_session public.pos_sessions;
  v_id uuid;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  v_role := public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('pos_add_expense', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_session_id, 'a', p_amount, 'c', p_category, 'd', p_description));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'invalid_amount: an expense must be more than R0 with at most 2 decimals';
  END IF;
  IF p_category IS NULL OR p_category NOT IN ('supplies', 'cleaning', 'transport', 'food', 'maintenance', 'stock', 'other') THEN
    RAISE EXCEPTION 'invalid_input: choose an expense category';
  END IF;
  IF p_description IS NULL OR length(btrim(p_description)) NOT BETWEEN 3 AND 200 THEN
    RAISE EXCEPTION 'invalid_input: describe the expense in 3 to 200 characters';
  END IF;

  -- Same lock as a sale: the close waits for this, and this sees a close that won.
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = p_session_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'session_closed'; END IF;
  IF v_session.opened_by <> p_actor AND public.role_level(v_role) < public.role_level('manager') THEN
    RAISE EXCEPTION 'session_not_yours';
  END IF;

  INSERT INTO public.pos_session_expenses (session_id, amount, category, description, created_by)
  VALUES (p_session_id, p_amount, p_category, btrim(p_description), p_actor) RETURNING id INTO v_id;
  PERFORM public._audit(p_actor, 'pos_expense_added', 'pos_session', p_session_id,
    jsonb_build_object('expense_id', v_id, 'amount', p_amount, 'category', p_category));
  v_response := jsonb_build_object('expense_id', v_id, 'session_id', p_session_id, 'amount', p_amount,
                                   'category', p_category, 'description', btrim(p_description));
  RETURN public._idem_finish('pos_add_expense', p_actor, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.pos_void_expense(
  p_actor uuid, p_expense_id uuid, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_role public.app_role;
  v_expense public.pos_session_expenses;
  v_session public.pos_sessions;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  v_role := public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('pos_void_expense', p_actor, p_idempotency_key,
    jsonb_build_object('e', p_expense_id, 'r', p_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'reason_required'; END IF;

  SELECT * INTO v_expense FROM public.pos_session_expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'expense_not_found'; END IF;
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = v_expense.session_id FOR SHARE;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'session_closed'; END IF;
  IF v_expense.voided_at IS NOT NULL THEN RAISE EXCEPTION 'already_voided'; END IF;
  IF v_expense.created_by <> p_actor AND public.role_level(v_role) < public.role_level('manager') THEN
    RAISE EXCEPTION 'forbidden: only the person who recorded it or a manager can void an expense' USING ERRCODE = '42501';
  END IF;

  UPDATE public.pos_session_expenses
  SET voided_by = p_actor, voided_at = now(), void_reason = btrim(p_reason)
  WHERE id = p_expense_id;
  PERFORM public._audit(p_actor, 'pos_expense_voided', 'pos_session', v_expense.session_id,
    jsonb_build_object('expense_id', p_expense_id, 'amount', v_expense.amount, 'reason', left(btrim(p_reason), 200)));
  v_response := jsonb_build_object('expense_id', p_expense_id, 'voided', true);
  RETURN public._idem_finish('pos_void_expense', p_actor, p_idempotency_key, v_response);
END;
$$;

-- 4. Close with expenses, discounts and the bank deposit ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_close_session(
  p_actor uuid, p_session_id uuid, p_actual_cash numeric, p_cash_deposited numeric, p_note text, p_idempotency_key text
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
  v_expenses numeric(10,2);
  v_discounts numeric(10,2);
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
    jsonb_build_object('s', p_session_id, 'a', p_actual_cash, 'd', p_cash_deposited, 'n', p_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_actual_cash IS NULL OR p_actual_cash < 0 OR p_actual_cash > 10000000
     OR p_actual_cash <> round(p_actual_cash, 2) THEN
    RAISE EXCEPTION 'invalid_amount: counted cash must be >= 0 with at most 2 decimals';
  END IF;
  IF p_cash_deposited IS NULL OR p_cash_deposited < 0 OR p_cash_deposited <> round(p_cash_deposited, 2) THEN
    RAISE EXCEPTION 'invalid_amount: the deposit must be >= 0 with at most 2 decimals';
  END IF;
  IF p_cash_deposited > p_actual_cash THEN
    RAISE EXCEPTION 'invalid_amount: the deposit cannot be more than the cash counted';
  END IF;

  -- Exclusive lock: waits for every in-flight sale and expense (which hold FOR SHARE), so expected cash is exact.
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
  SELECT COALESCE(SUM(e.amount), 0) INTO v_expenses
  FROM public.pos_session_expenses e WHERE e.session_id = p_session_id AND e.voided_at IS NULL;
  SELECT COALESCE(SUM(s.discount_rand), 0) INTO v_discounts
  FROM public.pos_sales s WHERE s.session_id = p_session_id AND s.status <> 'voided';

  v_expected := v_session.opening_float + v_cash_sales - v_cash_refunds - v_expenses;
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
      -- clock_timestamp(), not now(): the real close instant, after the exclusive lock.
      closed_at = clock_timestamp(),
      expected_cash = v_expected, actual_cash = p_actual_cash, variance = v_variance,
      tender_totals = v_totals, sales_count = v_count, close_note = left(p_note, 500),
      cash_sales = v_cash_sales, cash_refunds = v_cash_refunds, expenses_total = v_expenses,
      discounts_total = v_discounts, cash_deposited = p_cash_deposited,
      float_carried = p_actual_cash - p_cash_deposited,
      approval_status = v_approval
  WHERE id = p_session_id;

  PERFORM public._audit(p_actor, 'pos_session_closed', 'pos_session', p_session_id,
    jsonb_build_object('expected_cash', v_expected, 'actual_cash', p_actual_cash, 'variance', v_variance,
                       'expenses', v_expenses, 'discounts', v_discounts, 'deposited', p_cash_deposited,
                       'approval_status', v_approval, 'sales_count', v_count));
  v_response := jsonb_build_object('session_id', p_session_id,
    'opening_float', v_session.opening_float, 'cash_sales', v_cash_sales, 'cash_refunds', v_cash_refunds,
    'expenses_total', v_expenses, 'discounts_total', v_discounts,
    'expected_cash', v_expected, 'actual_cash', p_actual_cash, 'variance', v_variance,
    'cash_deposited', p_cash_deposited, 'float_carried', p_actual_cash - p_cash_deposited,
    'tender_totals', v_totals, 'sales_count', v_count, 'approval_status', v_approval);
  RETURN public._idem_finish('pos_close_session', p_actor, p_idempotency_key, v_response);
END;
$$;

-- The previous five-argument close: same rules, no deposit recorded. Kept so old code keeps working mid-deploy.
CREATE OR REPLACE FUNCTION public.pos_close_session(
  p_actor uuid, p_session_id uuid, p_actual_cash numeric, p_note text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.pos_close_session(p_actor, p_session_id, p_actual_cash, 0::numeric, p_note, p_idempotency_key);
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.pos_add_expense(uuid, uuid, numeric, text, text, text)',
    'public.pos_void_expense(uuid, uuid, text, text)',
    'public.pos_close_session(uuid, uuid, numeric, numeric, text, text)',
    'public.pos_close_session(uuid, uuid, numeric, text, text)',
    'public._pos_expense_guard()',
    'public._pos_session_update_guard()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- 5. Sales report: discounts, till cash-up, expenses; product revenue from what was paid ---------------------------
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
  v_till jsonb;
  v_sessions jsonb;
  v_expenses jsonb;
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
    'before_discounts', COALESCE((SELECT sum(subtotal) FROM s WHERE status <> 'voided'), 0),
    'discounts', COALESCE((SELECT sum(discount_rand) FROM s WHERE status <> 'voided'), 0),
    'discounted_count', (SELECT count(*) FROM s WHERE status <> 'voided' AND discount_rand > 0),
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

  -- Products (both channels; till refunds taken off). Till revenue is what was paid for the line after its
  -- discounts (line_total), pro-rated for refunded units.
  WITH lines AS (
    SELECT i.product_id, i.product_name, (i.quantity - i.refunded_quantity) AS qty,
           round(i.line_total * (i.quantity - i.refunded_quantity) / i.quantity, 2) AS revenue, 'pos' AS channel
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

  -- Till cash-ups: sessions CLOSED in the period (SAST)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'drawer', d.name, 'cashier', COALESCE(NULLIF(btrim(pr.full_name), ''), 'Staff member'),
      'opened_at', s.opened_at, 'closed_at', s.closed_at,
      'opening_float', s.opening_float, 'cash_sales', s.cash_sales, 'cash_refunds', s.cash_refunds,
      'expenses', s.expenses_total, 'discounts', s.discounts_total,
      'expected', s.expected_cash, 'counted', s.actual_cash, 'variance', s.variance,
      'deposited', s.cash_deposited, 'float_carried', s.float_carried,
      'approval', s.approval_status, 'approval_note', s.approval_note, 'close_note', s.close_note)
      ORDER BY s.closed_at), '[]'::jsonb)
  INTO v_sessions
  FROM public.pos_sessions s
  JOIN public.cash_drawers d ON d.id = s.drawer_id
  LEFT JOIN public.profiles pr ON pr.id = s.opened_by
  WHERE s.status = 'closed' AND s.closed_at >= v_start AND s.closed_at < v_end;

  -- Till expenses recorded in the period (not voided)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at', e.created_at, 'category', e.category,
      'description', e.description, 'amount', e.amount,
      'by', COALESCE(NULLIF(btrim(pr.full_name), ''), 'Staff member')) ORDER BY e.created_at), '[]'::jsonb)
  INTO v_expenses
  FROM public.pos_session_expenses e LEFT JOIN public.profiles pr ON pr.id = e.created_by
  WHERE e.voided_at IS NULL AND e.created_at >= v_start AND e.created_at < v_end;

  SELECT jsonb_build_object(
    'sessions_closed', count(*),
    'opening_floats', COALESCE(sum(s.opening_float), 0),
    'cash_sales', COALESCE(sum(s.cash_sales), 0),
    'cash_refunds', COALESCE(sum(s.cash_refunds), 0),
    'expenses', COALESCE(sum(s.expenses_total), 0),
    'expected', COALESCE(sum(s.expected_cash), 0),
    'counted', COALESCE(sum(s.actual_cash), 0),
    'variance', COALESCE(sum(s.variance), 0),
    'deposited', COALESCE(sum(s.cash_deposited), 0),
    'float_carried', COALESCE(sum(s.float_carried), 0),
    'variances_pending', count(*) FILTER (WHERE s.approval_status = 'pending'))
  INTO v_till
  FROM public.pos_sessions s
  WHERE s.status = 'closed' AND s.closed_at >= v_start AND s.closed_at < v_end;
  v_till := v_till || jsonb_build_object(
    'expenses_recorded', COALESCE((SELECT sum((x->>'amount')::numeric) FROM jsonb_array_elements(v_expenses) x), 0));

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
    'cashiers', v_cashiers, 'recent', v_recent,
    'till', v_till, 'till_sessions', v_sessions, 'expenses', v_expenses);
END;
$$;
REVOKE ALL ON FUNCTION public._sales_report(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sales_report(date, date) TO service_role;
