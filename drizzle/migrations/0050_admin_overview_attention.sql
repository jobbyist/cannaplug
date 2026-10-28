-- 28 Oct 2026: accurate admin numbers, paged customers, attention counts and automatic alerts, order archiving.
--   * admin_overview: revenue (today / last 7 days / this month / all time), a 7-day chart and the top products of the
--     last 30 days, counting online orders that were paid AND till sales net of refunds, by South African day.
--     This is the same rule the Reports tab uses, worked out inside the database (no row caps, no UTC day edges).
--   * admin_customers_page: members (not staff) with search and paging; spend counts paid orders only.
--   * _attention_counts / admin_attention_counts: what needs a person right now (orders to pack, ID checks, till
--     variances, low stock, EFT orders awaiting payment). Used for the sidebar badges.
--   * team_alerts_refresh: turns those counts into automatic notices under the bell (one row per condition, updated
--     in place, archived when the condition clears, unread again when it grows). Runs every 10 minutes through
--     pg_cron where available. Counts only, never names or health details.
--   * admin_set_order_archived: hide a cancelled or unpaid order from lists (kept for the records); a paid order
--     can never be archived. Unpaid orders are cancelled first, which releases their stock.
--   * staff_directory now also returns each person's last sign-in.

-- Columns --------------------------------------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archive_reason text CHECK (archive_reason IS NULL OR length(btrim(archive_reason)) BETWEEN 3 AND 200);
CREATE INDEX IF NOT EXISTS orders_archived_idx ON public.orders (archived_at) WHERE archived_at IS NOT NULL;

ALTER TABLE public.team_notifications
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS alert_count integer;
CREATE UNIQUE INDEX IF NOT EXISTS team_notifications_source_key_idx
  ON public.team_notifications (source_key) WHERE source_key IS NOT NULL;

-- Automatic alerts are changed only by team_alerts_refresh (it sets a transaction-local flag).
CREATE OR REPLACE FUNCTION public._team_alert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $fn$
BEGIN
  IF OLD.source_key IS NOT NULL AND current_setting('cannaplug.alert_sync', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'alert_readonly: automatic alerts update themselves';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER team_alert_guard BEFORE UPDATE ON public.team_notifications
  FOR EACH ROW EXECUTE FUNCTION public._team_alert_guard();

-- Revenue and overview ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._revenue_window(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT jsonb_build_object(
    'pos',
      COALESCE((SELECT sum(total) FROM public.pos_sales
                WHERE status <> 'voided' AND created_at >= p_start AND created_at < p_end), 0)
      - COALESCE((SELECT sum(amount) FROM public.pos_refunds
                  WHERE created_at >= p_start AND created_at < p_end), 0),
    'online',
      COALESCE((SELECT sum(total_rand) FROM public.orders
                WHERE status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
                  AND created_at >= p_start AND created_at < p_end), 0));
$fn$;

CREATE OR REPLACE FUNCTION public.admin_overview(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  c_tz constant text := 'Africa/Johannesburg';
  v_today date := (now() AT TIME ZONE c_tz)::date;
  v_tomorrow timestamptz := ((v_today + 1)::timestamp AT TIME ZONE c_tz);
  v_today_start timestamptz := (v_today::timestamp AT TIME ZONE c_tz);
  v_week_start timestamptz := ((v_today - 6)::timestamp AT TIME ZONE c_tz);
  v_month_start timestamptz := (date_trunc('month', v_today::timestamp) AT TIME ZONE c_tz);
  v_top_start timestamptz := ((v_today - 29)::timestamp AT TIME ZONE c_tz);
  v_daily jsonb;
  v_top jsonb;
  v_counts jsonb;
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');

  SELECT COALESCE(jsonb_agg(jsonb_build_object('day', g::date, 'pos', (r->>'pos')::numeric,
                                               'online', (r->>'online')::numeric) ORDER BY g), '[]'::jsonb)
  INTO v_daily
  FROM generate_series(v_today - 6, v_today, interval '1 day') g,
       LATERAL (SELECT public._revenue_window((g::date::timestamp AT TIME ZONE c_tz),
                                              ((g::date + 1)::timestamp AT TIME ZONE c_tz))) w(r);

  -- Best sellers of the last 30 days across both channels; till revenue is the line total after discounts,
  -- pro-rated for refunded units (the same rule as Reports).
  WITH lines AS (
    SELECT i.product_name, (i.quantity - i.refunded_quantity) AS qty,
           round(i.line_total * (i.quantity - i.refunded_quantity) / i.quantity, 2) AS revenue
    FROM public.pos_sale_items i JOIN public.pos_sales s ON s.id = i.sale_id
    WHERE s.status <> 'voided' AND s.created_at >= v_top_start AND s.created_at < v_tomorrow
    UNION ALL
    SELECT i.product_name, i.quantity, i.unit_price_rand * i.quantity
    FROM public.order_items i JOIN public.orders o ON o.id = i.order_id
    WHERE o.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
      AND o.created_at >= v_top_start AND o.created_at < v_tomorrow
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', t.name, 'qty', t.qty, 'revenue', t.revenue)
                            ORDER BY t.qty DESC, t.revenue DESC, t.name), '[]'::jsonb)
  INTO v_top
  FROM (SELECT product_name AS name, sum(qty) AS qty, sum(revenue) AS revenue
        FROM lines WHERE qty > 0 GROUP BY product_name
        ORDER BY sum(qty) DESC, sum(revenue) DESC, product_name LIMIT 5) t;

  v_counts := jsonb_build_object(
    'online_orders', (SELECT count(*) FROM public.orders WHERE archived_at IS NULL),
    'paid_online', (SELECT count(*) FROM public.orders
                    WHERE status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')),
    'till_sales', (SELECT count(*) FROM public.pos_sales WHERE status <> 'voided'),
    'customers', (SELECT count(*) FROM public.user_roles ur
                  WHERE ur.role = 'customer'
                    AND NOT EXISTS (SELECT 1 FROM public.user_roles s
                                    WHERE s.user_id = ur.user_id AND s.role IN ('budtender', 'manager', 'admin'))));

  RETURN jsonb_build_object(
    'today', public._revenue_window(v_today_start, v_tomorrow),
    'week', public._revenue_window(v_week_start, v_tomorrow),
    'month', public._revenue_window(v_month_start, v_tomorrow),
    'all_time', public._revenue_window('-infinity'::timestamptz, 'infinity'::timestamptz),
    'daily', v_daily,
    'top_products', v_top,
    'counts', v_counts);
END;
$fn$;

-- Customers ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_customers_page(p_actor uuid, p_search text, p_limit integer, p_offset integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_q text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_pat text;
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  IF v_q IS NOT NULL AND length(v_q) > 100 THEN RAISE EXCEPTION 'invalid_input: search is too long'; END IF;
  v_pat := CASE WHEN v_q IS NULL THEN NULL
                ELSE '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' END;

  RETURN (
    WITH base AS (
      SELECT ur.user_id, ur.created_at AS member_since, p.full_name, p.phone, u.email
      FROM public.user_roles ur
      JOIN auth.users u ON u.id = ur.user_id
      LEFT JOIN public.profiles p ON p.id = ur.user_id
      WHERE ur.role = 'customer'
        AND NOT EXISTS (SELECT 1 FROM public.user_roles s
                        WHERE s.user_id = ur.user_id AND s.role IN ('budtender', 'manager', 'admin'))
        AND (v_pat IS NULL OR p.full_name ILIKE v_pat OR p.phone ILIKE v_pat OR u.email ILIKE v_pat)
    ), page AS (
      SELECT * FROM base ORDER BY member_since DESC, user_id LIMIT v_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM base),
      'rows', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', g.user_id, 'full_name', g.full_name, 'phone', g.phone, 'email', g.email,
          'member_since', g.member_since, 'order_count', COALESCE(o.n, 0), 'spend_rand', COALESCE(o.total, 0))
          ORDER BY g.member_since DESC, g.user_id)
        FROM page g
        LEFT JOIN LATERAL (
          SELECT count(*) AS n, sum(x.total_rand) AS total FROM public.orders x
          WHERE x.user_id = g.user_id
            AND x.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')) o ON true), '[]'::jsonb)));
END;
$fn$;

-- Attention counts and automatic alerts ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._attention_counts()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT jsonb_build_object(
    'orders_to_pack', (SELECT count(*) FROM public.orders WHERE status = 'confirmed' AND archived_at IS NULL),
    'id_checks', (SELECT count(*) FROM public.customer_verification WHERE status = 'pending'),
    'variances', (SELECT count(*) FROM public.pos_sessions WHERE approval_status = 'pending'),
    'low_stock', (SELECT count(*) FROM public.inventory_availability v
                  JOIN public.products p ON p.id = v.product_id
                  WHERE p.is_active AND p.track_stock AND v.batches > 0 AND v.available <= p.low_stock_threshold),
    'eft_waiting', (SELECT count(*) FROM public.orders
                    WHERE status = 'awaiting_payment' AND payment_method = 'eft' AND archived_at IS NULL));
$fn$;

CREATE OR REPLACE FUNCTION public.admin_attention_counts(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  RETURN public._attention_counts();
END;
$fn$;

CREATE OR REPLACE FUNCTION public._team_alert_sync(
  p_key text, p_count integer, p_kind text, p_min_role text, p_title text, p_body text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_row public.team_notifications;
BEGIN
  PERFORM set_config('cannaplug.alert_sync', 'on', true);
  SELECT * INTO v_row FROM public.team_notifications WHERE source_key = p_key FOR UPDATE;
  IF p_count > 0 THEN
    IF NOT FOUND THEN
      INSERT INTO public.team_notifications
        (title, body, kind, min_role, status, pinned, published_at, source_key, alert_count)
      VALUES (p_title, p_body, p_kind, p_min_role, 'published', false, now(), p_key, p_count);
      RETURN true;
    ELSIF v_row.status <> 'published' OR v_row.title IS DISTINCT FROM p_title
          OR v_row.body IS DISTINCT FROM p_body THEN
      -- Shown as unread again only when it grows or comes back; a shrinking count updates quietly.
      UPDATE public.team_notifications SET
        title = p_title, body = p_body, kind = p_kind, min_role = p_min_role, status = 'published',
        published_at = CASE WHEN v_row.status <> 'published' THEN now() ELSE v_row.published_at END,
        alert_count = p_count,
        updated_at = CASE WHEN v_row.status <> 'published' OR p_count > COALESCE(v_row.alert_count, 0)
                          THEN now() ELSE v_row.updated_at END
      WHERE id = v_row.id;
      RETURN true;
    END IF;
  ELSIF FOUND AND v_row.status = 'published' THEN
    UPDATE public.team_notifications SET status = 'archived', alert_count = 0, updated_at = now()
    WHERE id = v_row.id;
    RETURN true;
  END IF;
  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._plural(p_n integer, p_one text, p_many text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = ''
AS $fn$ SELECT p_n::text || ' ' || CASE WHEN p_n = 1 THEN p_one ELSE p_many END; $fn$;

CREATE OR REPLACE FUNCTION public.team_alerts_refresh()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v jsonb := public._attention_counts();
  n integer;
  v_changed integer := 0;
BEGIN
  n := (v->>'variances')::integer;
  IF public._team_alert_sync('alert:variances', n, 'alert', 'manager', 'Till variance awaiting approval',
       public._plural(n, 'till cash-up has', 'till cash-ups have') || ' a variance that needs a manager''s approval.') THEN
    v_changed := v_changed + 1;
  END IF;
  n := (v->>'low_stock')::integer;
  IF public._team_alert_sync('alert:low-stock', n, 'alert', 'budtender', 'Low stock',
       public._plural(n, 'product is', 'products are') || ' at or below the low-stock level.') THEN
    v_changed := v_changed + 1;
  END IF;
  n := (v->>'id_checks')::integer;
  IF public._team_alert_sync('alert:id-checks', n, 'reminder', 'budtender', 'ID checks waiting',
       public._plural(n, 'ID submission is', 'ID submissions are') || ' waiting for review.') THEN
    v_changed := v_changed + 1;
  END IF;
  n := (v->>'orders_to_pack')::integer;
  IF public._team_alert_sync('alert:orders-to-pack', n, 'reminder', 'budtender', 'Orders to pack',
       public._plural(n, 'paid order is', 'paid orders are') || ' waiting to be packed.') THEN
    v_changed := v_changed + 1;
  END IF;
  n := (v->>'eft_waiting')::integer;
  IF public._team_alert_sync('alert:eft-waiting', n, 'reminder', 'manager', 'EFT orders awaiting payment',
       public._plural(n, 'EFT order is', 'EFT orders are') || ' still awaiting payment.') THEN
    v_changed := v_changed + 1;
  END IF;
  IF v_changed > 0 THEN
    PERFORM public._audit(NULL, 'team_alerts_refreshed', 'team_notification', NULL,
                          jsonb_build_object('changed', v_changed));
  END IF;
  RETURN v_changed;
END;
$fn$;

-- Order archiving ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_order_archived(
  p_actor uuid, p_order_id uuid, p_archived boolean, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_cached jsonb;
  v_order public.orders;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_response jsonb;
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('order_archive', p_actor, p_idempotency_key,
    jsonb_build_object('o', p_order_id, 'a', p_archived, 'r', v_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_archived IS NULL THEN RAISE EXCEPTION 'invalid_input'; END IF;
  IF length(v_reason) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'reason_required'; END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;

  IF p_archived THEN
    IF v_order.archived_at IS NOT NULL THEN
      v_response := jsonb_build_object('changed', false, 'archived', true);
      RETURN public._idem_finish('order_archive', p_actor, p_idempotency_key, v_response);
    END IF;
    IF EXISTS (SELECT 1 FROM public.payment_transactions WHERE order_id = p_order_id AND status = 'succeeded') THEN
      RAISE EXCEPTION 'order_paid: a paid order cannot be archived';
    END IF;
    IF v_order.status NOT IN ('awaiting_payment', 'cancelled') THEN
      RAISE EXCEPTION 'invalid_order_state: only cancelled or unpaid orders can be archived';
    END IF;
    IF v_order.status = 'awaiting_payment' THEN
      PERFORM public.transition_order_status(p_order_id, 'cancelled', p_actor, 'Archived: ' || v_reason);
    END IF;
    UPDATE public.orders SET archived_at = now(), archived_by = p_actor, archive_reason = v_reason
    WHERE id = p_order_id;
  ELSE
    IF v_order.archived_at IS NULL THEN
      v_response := jsonb_build_object('changed', false, 'archived', false);
      RETURN public._idem_finish('order_archive', p_actor, p_idempotency_key, v_response);
    END IF;
    UPDATE public.orders SET archived_at = NULL, archived_by = NULL, archive_reason = NULL
    WHERE id = p_order_id;
  END IF;

  PERFORM public._audit(p_actor, CASE WHEN p_archived THEN 'order_archived' ELSE 'order_unarchived' END,
                        'order', p_order_id,
                        jsonb_build_object('order_number', v_order.order_number, 'reason', left(v_reason, 200)));
  v_response := jsonb_build_object('changed', true, 'archived', p_archived);
  RETURN public._idem_finish('order_archive', p_actor, p_idempotency_key, v_response);
END;
$fn$;

-- Staff directory: add the last sign-in ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_directory(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager');
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'user_id', s.user_id, 'full_name', p.full_name, 'email', u.email,
             'role', s.role::text, 'since', s.since, 'last_sign_in', u.last_sign_in_at)
             ORDER BY public.role_level(s.role) DESC, p.full_name NULLS LAST)
    FROM (
      SELECT DISTINCT ON (ur.user_id) ur.user_id, ur.role, ur.created_at AS since
      FROM public.user_roles ur
      WHERE ur.role IN ('budtender', 'manager', 'admin')
      ORDER BY ur.user_id, public.role_level(ur.role) DESC
    ) s
    JOIN auth.users u ON u.id = s.user_id
    LEFT JOIN public.profiles p ON p.id = s.user_id
  ), '[]'::jsonb);
END;
$fn$;

DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._revenue_window(timestamptz, timestamptz)',
    'public.admin_overview(uuid)',
    'public.admin_customers_page(uuid, text, integer, integer)',
    'public._attention_counts()',
    'public.admin_attention_counts(uuid)',
    'public._team_alert_sync(text, integer, text, text, text, text)',
    'public.team_alerts_refresh()',
    'public.admin_set_order_archived(uuid, uuid, boolean, text, text)',
    'public.staff_directory(uuid)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  -- Refresh the automatic alerts every 10 minutes where pg_cron exists (not in local test databases).
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('team-alerts-refresh', '*/10 * * * *', 'SELECT public.team_alerts_refresh()');
  END IF;
END $do$;

SELECT public.team_alerts_refresh();
