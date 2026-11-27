-- 27 Nov 2026: the Admin "Basket reminders" tile now counts from the record of emails queued (notification_events),
-- not from the current basket's timestamps. A member who empties a basket and later starts a new reminder cycle used
-- to overwrite their earlier first/second email times, so repeat cycles were undercounted. Everything else is as before:
-- staff only, counts only, paid orders within 7 days after a first reminder, staff purchases left out.
-- Rollback: supabase/rollbacks/20261127010000_admin_cart_recovery_history_rollback.sql (back to 20261127009000).

CREATE OR REPLACE FUNCTION public.admin_cart_recovery(p_actor uuid, p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_from timestamptz := now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 365));
  v_rec record;
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  SELECT count(DISTINCT o.id) AS orders
  INTO v_rec
  FROM public.notification_events e
  JOIN public.orders o ON o.user_id = e.recipient_user_id
   AND o.created_at >= e.created_at AND o.created_at < e.created_at + interval '7 days'
  WHERE e.template = 'cart_reminder' AND e.created_at >= v_from AND (e.data->>'stage') = '1'
    AND o.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
    AND NOT o.staff_purchase;
  RETURN jsonb_build_object(
    'days', v_days,
    'baskets_saved', (SELECT count(*) FROM public.member_carts WHERE items <> '[]'::jsonb AND updated_at >= v_from),
    'first_emails', (SELECT count(*) FROM public.notification_events WHERE template = 'cart_reminder' AND created_at >= v_from AND (data->>'stage') = '1'),
    'second_emails', (SELECT count(*) FROM public.notification_events WHERE template = 'cart_reminder' AND created_at >= v_from AND (data->>'stage') = '2'),
    'unsubscribed', (SELECT count(*) FROM public.member_carts WHERE unsubscribed_at >= v_from),
    'recovered_orders', v_rec.orders,
    'recovered_rand', COALESCE((
      SELECT sum(t.total_rand) FROM (
        SELECT DISTINCT o.id, o.total_rand
        FROM public.notification_events e
        JOIN public.orders o ON o.user_id = e.recipient_user_id
         AND o.created_at >= e.created_at AND o.created_at < e.created_at + interval '7 days'
        WHERE e.template = 'cart_reminder' AND e.created_at >= v_from AND (e.data->>'stage') = '1'
          AND o.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
          AND NOT o.staff_purchase) t), 0));
END;
$fn$;
