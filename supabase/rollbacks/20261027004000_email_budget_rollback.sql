-- Rollback for 20261027004000_email_budget: no daily email budget; the earlier ID and welcome emails come back.
CREATE OR REPLACE FUNCTION public.notification_claim(p_limit integer, p_lease_seconds integer DEFAULT 120)
RETURNS SETOF public.notification_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT n.id FROM public.notification_events n
    WHERE ((n.status IN ('queued', 'failed') AND n.next_attempt_at <= now())
        OR (n.status = 'sending' AND n.locked_until < now()))
    ORDER BY n.priority, n.next_attempt_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.notification_events n
  SET status = 'sending', attempts = n.attempts + 1,
      locked_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 120), 10))
  FROM due WHERE n.id = due.id
  RETURNING n.*;
END;
$$;

CREATE OR REPLACE FUNCTION public._notify_member_welcome()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_email text;
BEGIN
  BEGIN
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = NEW.id;
    IF v_email IS NOT NULL THEN
      PERFORM public.notification_enqueue('email', 'member_welcome', v_email, NEW.id, 'transactional',
        jsonb_build_object('contact_name', NEW.full_name), 'welcome:' || NEW.id::text);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'welcome email skipped: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public._notify_id_verification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_email text;
  v_name text;
  v_template text;
  v_stamp text;
  v_data jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  BEGIN
    v_template := CASE NEW.status WHEN 'pending' THEN 'id_submitted' WHEN 'verified' THEN 'id_approved'
                                  WHEN 'rejected' THEN 'id_rejected' ELSE NULL END;
    IF v_template IS NULL THEN RETURN NEW; END IF;
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = NEW.user_id;
    SELECT p.full_name INTO v_name FROM public.profiles p WHERE p.id = NEW.user_id;
    v_stamp := extract(epoch FROM COALESCE(NEW.reviewed_at, NEW.submitted_at, now()))::bigint::text;
    v_data := jsonb_build_object('contact_name', v_name, 'rejection_code', NEW.rejection_code,
                                 'document_expires_on', NEW.document_expires_on);
    IF v_email IS NOT NULL THEN
      PERFORM public.notification_enqueue('email', v_template, v_email, NEW.user_id, 'transactional', v_data,
        'idv:' || NEW.user_id::text || ':' || NEW.status || ':' || v_stamp);
    END IF;
    IF NEW.status = 'pending' THEN
      PERFORM public.notification_enqueue_staff('staff_id_review', jsonb_build_object('member_name', v_name),
        'idvstaff:' || NEW.user_id::text || ':' || v_stamp);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'id verification email skipped: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
DROP FUNCTION IF EXISTS public.email_budget_status();
DROP FUNCTION IF EXISTS public._emails_sent_24h();
DROP FUNCTION IF EXISTS public._email_tier(text);
DROP TABLE IF EXISTS public.email_budget_settings;
DROP INDEX IF EXISTS public.notification_events_sent_idx;
DROP INDEX IF EXISTS public.pos_receipt_sends_created_idx;
