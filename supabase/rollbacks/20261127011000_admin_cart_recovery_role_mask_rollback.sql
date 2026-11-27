-- Rollback for 20261127011000: the function as in 20261127010000.
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
