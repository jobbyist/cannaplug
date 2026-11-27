-- 27 Nov 2026: win back unpaid online orders, and close a race in the pay-in-store limit.
--   * abandoned_order_reminders_enqueue(): queues at most ONE reminder email per unpaid order, run every 10 minutes.
--       - pay    : card / PayPal / EFT orders, once they have been waiting 30 minutes and the stock hold still has 15+ minutes left.
--       - collect: pay-in-store reservations, once the 24-hour hold has 6 hours or less left (and more than 30 minutes).
--     Skipped: orders with no live stock hold, archived or staff purchases, deactivated or deleted accounts, and EFT / card orders that
--     already have a payment waiting on review or approval (the customer has paid and is waiting on us).
--     The email carries the order number, total and hold time only. Dedupe key abandon:<order>:<kind>, so it never repeats.
--   * checkout_place_order takes a per-member lock before it counts a member's unpaid pay-in-store orders, so two simultaneous
--     requests can no longer both pass the two-order limit. Rewritten from the live definition; it refuses to run if the line is not found.
--   * Rollback: supabase/rollbacks/20261127006000_abandoned_order_reminders_rollback.sql.

CREATE OR REPLACE FUNCTION public.abandoned_order_reminders_enqueue()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  r record;
  v_kind text;
  v_n integer := 0;
BEGIN
  FOR r IN
    SELECT o.id, o.user_id, o.order_number, o.total_rand, o.contact_name, o.delivery_method, o.payment_method,
           u.email, h.hold_until
    FROM public.orders o
    JOIN auth.users u ON u.id = o.user_id
    JOIN LATERAL (SELECT min(sr.expires_at) AS hold_until FROM public.stock_reservations sr
                  WHERE sr.order_id = o.id AND sr.status = 'held') h ON true
    WHERE o.status = 'awaiting_payment' AND o.archived_at IS NULL AND NOT o.staff_purchase
      AND u.email IS NOT NULL AND h.hold_until IS NOT NULL AND h.hold_until > now()
      AND NOT EXISTS (SELECT 1 FROM public.profiles p
                      WHERE p.id = o.user_id AND (p.deactivated_at IS NOT NULL OR p.deleted_at IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM public.payment_transactions pt
                      WHERE pt.order_id = o.id AND pt.status IN ('pending_approval', 'review', 'succeeded'))
      AND (
        (o.payment_method = 'cash'
           AND h.hold_until <= now() + interval '6 hours' AND h.hold_until > now() + interval '30 minutes')
        OR (COALESCE(o.payment_method, '') <> 'cash'
           AND o.created_at <= now() - interval '30 minutes' AND h.hold_until > now() + interval '15 minutes')
      )
  LOOP
    v_kind := CASE WHEN r.payment_method = 'cash' THEN 'collect' ELSE 'pay' END;
    IF public.notification_enqueue(
         'email', 'order_abandoned', r.email, r.user_id, 'transactional',
         jsonb_build_object('order_id', r.id, 'order_number', r.order_number, 'total_rand', r.total_rand,
                            'contact_name', r.contact_name, 'delivery_method', r.delivery_method,
                            'payment_method', r.payment_method, 'kind', v_kind,
                            'hold_until', to_char(r.hold_until AT TIME ZONE 'Africa/Johannesburg', 'FMDay HH24:MI')),
         'abandon:' || r.id::text || ':' || v_kind) IS NOT NULL THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$fn$;
REVOKE ALL ON FUNCTION public.abandoned_order_reminders_enqueue() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abandoned_order_reminders_enqueue() TO service_role;

DO $mig$
DECLARE
  v_sig constant text := 'public.checkout_place_order(uuid,jsonb,text,text,text,uuid,text,numeric,text,text)';
  v_old constant text := E'    IF (SELECT count(*) FROM public.orders o\n        WHERE o.user_id = p_user_id AND o.payment_method = ''cash''';
  v_new constant text := E'    PERFORM pg_advisory_xact_lock(hashtext(''pay_in_store:'' || p_user_id::text)); -- pis_lock\n' || v_old;
  v_def text := pg_get_functiondef(v_sig::regprocedure);
BEGIN
  IF position('-- pis_lock' IN v_def) > 0 THEN RETURN; END IF;
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'abandoned_order_reminders: pay-in-store count not found in checkout_place_order';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('abandoned-order-reminders', '*/10 * * * *', 'SELECT public.abandoned_order_reminders_enqueue()');
  END IF;
END
$mig$;
