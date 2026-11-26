-- Rollback for 20261126001000_black_friday_2026: online orders go back to needing a verified ID, the Black Friday rules
-- (double points, 5-tube Plug Back, scheduled sales) go away. Roll the app back first.
-- Sales already started stay on their products until their end time (the end-of-sale sweep still runs). Points already
-- doubled and tubes already spent stay as they are. The scheduled_sales table is kept (history); only the sweep is removed.

DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cannaplug-start-sales';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.plug_back_tubes_per_reward()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 10 $$;

CREATE OR REPLACE FUNCTION public.accrue_order_loyalty(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
  v_points integer;
BEGIN
  PERFORM public._require_read_committed();
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('accrued', false, 'reason', 'order_not_found'); END IF;
  IF v_order.status <> 'completed' THEN RETURN jsonb_build_object('accrued', false, 'reason', 'not_completed'); END IF;
  v_points := public._loyalty_points_for_amount(v_order.total_rand - v_order.delivery_fee_rand);
  PERFORM public._referral_check(v_order.user_id);
  IF v_points <= 0 THEN RETURN jsonb_build_object('accrued', false, 'reason', 'no_points'); END IF;
  INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, order_id, points)
  VALUES (v_order.user_id, 'earn', 'order', v_order.id, v_order.id, v_points)
  ON CONFLICT (source_type, source_id) DO NOTHING;
  IF FOUND THEN
    RETURN jsonb_build_object('accrued', true, 'points', v_points);
  END IF;
  RETURN jsonb_build_object('accrued', false, 'reason', 'already_accrued');
END;
$$;

CREATE OR REPLACE FUNCTION public._require_verified_member(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_expires date;
BEGIN
  IF public._is_staff(p_user_id) THEN
    RETURN;
  END IF;
  SELECT cv.status, cv.document_expires_on INTO v_status, v_expires
  FROM public.customer_verification cv WHERE cv.user_id = p_user_id;
  IF v_status = 'verified' THEN
    IF v_expires IS NOT NULL AND v_expires < current_date THEN
      RAISE EXCEPTION 'verification_expired: your ID document has expired — upload a current one to keep ordering';
    END IF;
    RETURN;
  ELSIF v_status = 'provisional' THEN
    RAISE EXCEPTION 'verification_provisional: your account is active in store. Submit your ID to unlock the online store';
  ELSIF v_status = 'pending' THEN
    RAISE EXCEPTION 'verification_pending: your ID is being reviewed — you can order once it is approved';
  END IF;
  RAISE EXCEPTION 'verification_required: verify your ID before placing an order';
END;
$$;

DROP FUNCTION IF EXISTS public.schedule_black_friday_2026();
DROP FUNCTION IF EXISTS public.products_start_due_sales(uuid);
DROP FUNCTION IF EXISTS public.bfcm_campaign_active(timestamptz);
