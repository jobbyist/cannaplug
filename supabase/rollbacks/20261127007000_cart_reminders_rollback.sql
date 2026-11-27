-- Rollback for 20261127007000_cart_reminders: stop cart emails, remove the cart-bonus rule and the saved baskets.
-- Order points already earned stay as they are. Saved baskets are deleted (they only copy what members had in their browsers).
DO $rb$
DECLARE
  v_sig constant text := 'public.accrue_order_loyalty(uuid)';
  v_new constant text := 'v_double := v_points > 0 AND (public.bfcm_campaign_active(v_order.created_at) OR public._cart_bonus_applies(v_order.id) /* cart_bonus */)';
  v_old constant text := 'v_double := v_points > 0 AND public.bfcm_campaign_active(v_order.created_at)';
  v_def text := pg_get_functiondef(v_sig::regprocedure);
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cart-reminders';
  END IF;
  IF position(v_new IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_new, v_old);
  END IF;
END
$rb$;
CREATE OR REPLACE FUNCTION public._email_tier(p_template text)
RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_template IN ('staff_id_review', 'id_submitted') THEN 0
    WHEN p_template IN ('promo_announcement', 'journal_digest') THEN 3
    WHEN p_template IN ('staff_low_stock', 'back_in_stock', 'id_expiring', 'newsletter_welcome',
                        'contact_form_ack', 'id_approved', 'member_import_invite') THEN 2
    ELSE 1
  END;
$$;
DROP FUNCTION IF EXISTS public.cart_reminders_enqueue(timestamptz);
DROP FUNCTION IF EXISTS public._cart_bonus_applies(uuid);
DROP FUNCTION IF EXISTS public.cart_unsubscribe(text);
DROP FUNCTION IF EXISTS public.cart_get(uuid);
DROP FUNCTION IF EXISTS public.cart_save(uuid, jsonb);
DROP TABLE IF EXISTS public.member_carts;
