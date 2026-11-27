-- Rollback for 20261127010000_admin_cart_recovery_history: the function as in 20261127009000.
CREATE OR REPLACE FUNCTION public.admin_cart_recovery(p_actor uuid, p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_from timestamptz := now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 365));
  v_rec record;
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  SELECT count(DISTINCT o.id) AS orders, COALESCE(sum(o.total_rand), 0) AS revenue
  INTO v_rec
  FROM public.member_carts c
  JOIN public.orders o ON o.user_id = c.user_id
   AND o.created_at >= c.reminder_1_at AND o.created_at < c.reminder_1_at + interval '7 days'
  WHERE c.reminder_1_at >= v_from
    AND o.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
    AND NOT o.staff_purchase;
  RETURN jsonb_build_object(
    'days', LEAST(GREATEST(COALESCE(p_days, 30), 1), 365),
    'baskets_saved', (SELECT count(*) FROM public.member_carts WHERE items <> '[]'::jsonb AND updated_at >= v_from),
    'first_emails', (SELECT count(*) FROM public.member_carts WHERE reminder_1_at >= v_from),
    'second_emails', (SELECT count(*) FROM public.member_carts WHERE reminder_2_at >= v_from),
    'unsubscribed', (SELECT count(*) FROM public.member_carts WHERE unsubscribed_at >= v_from),
    'recovered_orders', v_rec.orders,
    'recovered_rand', v_rec.revenue);
END;
$fn$;
