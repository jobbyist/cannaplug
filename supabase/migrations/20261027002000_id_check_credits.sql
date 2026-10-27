-- 27 Oct 2026: ID-check credits (owner's decision).
--   Every new member costs 3 credits, charged once at their first ID submission. The shop starts with 400 credits for
--   new sign-ups plus 558 credits reserved for the 186 members coming in from the customer export (186 x 3).
--   Sign-ups since 26 Oct 2026 00:00 SAST are charged from the opening balance by this migration.
--   When 100 or fewer unreserved credits are left, one email goes to admin@ and info@ asking for a top-up; it goes
--   again only after a top-up lifts the balance above 100, or once a day while the balance is at or below zero.
--   When unreserved credits cannot cover a check, new ID submissions are refused (id_credits_depleted) and the
--   sign-up form says so (id_credits_open). Imported members are charged from the reserve and are not blocked
--   while it lasts.
--
--   * id_credit_ledger: append-only. credits = change to the total; reserved_delta = change to the reserved pool.
--     available = total - reserved. One charge per member (unique index), so retries and resubmissions are free.
--   * A trigger on customer_verification charges in the same transaction as the submission. Imported members (auth
--     app_metadata source = 'customer_import', which only the server can set) are charged from the reserve while it lasts.
--   * id_credits_summary and id_credits_top_up (any staff), id_credits_set_reserve (admin): SECURITY DEFINER,
--     search_path '', explicit actor, idempotency key, audit row, service_role only.
--   * No member names, ID or document data are stored here or put in the alert email.

CREATE TABLE IF NOT EXISTS public.id_credit_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  cost_per_check integer NOT NULL DEFAULT 3 CHECK (cost_per_check BETWEEN 0 AND 100),
  low_balance_threshold integer NOT NULL DEFAULT 100 CHECK (low_balance_threshold BETWEEN 0 AND 1000000),
  alert_emails text[] NOT NULL DEFAULT ARRAY['admin@cannaplug012.co.za', 'info@cannaplug012.co.za']
    CHECK (cardinality(alert_emails) BETWEEN 1 AND 5),
  -- Set when the low-balance email goes out; cleared when a top-up lifts the balance above the threshold.
  low_alert_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.id_credit_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.id_credit_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('opening', 'top_up', 'charge', 'reserve', 'release', 'adjustment')),
  credits integer NOT NULL CHECK (credits BETWEEN -1000000 AND 1000000),
  reserved_delta integer NOT NULL DEFAULT 0 CHECK (reserved_delta BETWEEN -1000000 AND 1000000),
  member_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_user_id uuid,
  note text CHECK (note IS NULL OR length(note) <= 200),
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'charge' OR credits <= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS id_credit_one_charge_per_member
  ON public.id_credit_ledger (member_user_id) WHERE kind = 'charge';
CREATE INDEX IF NOT EXISTS id_credit_ledger_created_idx ON public.id_credit_ledger (created_at DESC);

ALTER TABLE public.id_credit_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.id_credit_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.id_credit_settings, public.id_credit_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.id_credit_settings, public.id_credit_ledger TO service_role;

CREATE OR REPLACE FUNCTION public._id_credit_ledger_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'id_credit_ledger is append-only';
END;
$$;
CREATE OR REPLACE TRIGGER id_credit_ledger_no_change BEFORE UPDATE OR DELETE ON public.id_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public._id_credit_ledger_immutable();
REVOKE ALL ON FUNCTION public._id_credit_ledger_immutable() FROM PUBLIC, anon, authenticated;

-- Opening balance: 400 credits for new sign-ups, plus 558 reserved for the 186 imported members.
INSERT INTO public.id_credit_ledger (kind, credits, reserved_delta, note, idempotency_key)
VALUES ('opening', 400, 0, 'Opening balance for new sign-ups', 'seed:opening'),
       ('reserve', 558, 558, 'Reserved for 186 members from the customer export (3 credits each)', 'seed:import-reserve')
ON CONFLICT (idempotency_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public._id_credit_balance()
RETURNS TABLE (total integer, reserved integer, available integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(sum(credits), 0)::integer,
         COALESCE(sum(reserved_delta), 0)::integer,
         (COALESCE(sum(credits), 0) - COALESCE(sum(reserved_delta), 0))::integer
  FROM public.id_credit_ledger;
$$;
REVOKE ALL ON FUNCTION public._id_credit_balance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._id_credit_balance() TO service_role;

-- Sends the low-balance email when it is due. Caller holds the settings row lock.
CREATE OR REPLACE FUNCTION public._id_credit_maybe_alert(p_actor uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  s public.id_credit_settings;
  b record;
  v_email text;
  v_due boolean;
BEGIN
  SELECT * INTO s FROM public.id_credit_settings WHERE id;
  SELECT * INTO b FROM public._id_credit_balance();
  IF b.available > s.low_balance_threshold THEN
    RETURN false;
  END IF;
  v_due := s.low_alert_sent_at IS NULL
        OR (b.available <= 0 AND s.low_alert_sent_at < now() - interval '1 day');
  IF NOT v_due THEN
    RETURN false;
  END IF;
  FOREACH v_email IN ARRAY s.alert_emails LOOP
    PERFORM public.notification_enqueue('email', 'id_credits_low', v_email, NULL, 'staff',
      jsonb_build_object('available', b.available, 'reserved', b.reserved, 'total', b.total,
                         'threshold', s.low_balance_threshold, 'cost_per_check', s.cost_per_check),
      'id_credits_low:' || to_char(now(), 'YYYYMMDDHH24MISS') || ':' || v_email);
  END LOOP;
  UPDATE public.id_credit_settings SET low_alert_sent_at = now(), updated_at = now() WHERE id;
  PERFORM public._audit(p_actor, 'id_credits_low_alert', 'id_credits', NULL,
    jsonb_build_object('available', b.available, 'reserved', b.reserved, 'recipients', cardinality(s.alert_emails)));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public._id_credit_maybe_alert(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._id_credit_maybe_alert(uuid) TO service_role;

-- Charges a member once for their ID check. Imported members use the reserve while it lasts.
CREATE OR REPLACE FUNCTION public._id_credit_charge(p_member uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  s public.id_credit_settings;
  b record;
  v_imported boolean;
  v_from_reserve boolean;
BEGIN
  -- One charge at a time, so the balance and the alert stay consistent.
  SELECT * INTO s FROM public.id_credit_settings WHERE id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.id_credit_ledger WHERE kind = 'charge' AND member_user_id = p_member) THEN
    RETURN false;
  END IF;
  SELECT * INTO b FROM public._id_credit_balance();
  -- app_metadata, not user_metadata: only the server can set it, so a sign-up cannot claim to be imported.
  SELECT COALESCE(u.raw_app_meta_data->>'source', '') = 'customer_import' INTO v_imported
  FROM auth.users u WHERE u.id = p_member;
  v_from_reserve := COALESCE(v_imported, false) AND b.reserved >= s.cost_per_check;
  IF NOT v_from_reserve AND b.available < s.cost_per_check THEN
    RAISE EXCEPTION 'id_credits_depleted: ID-check credits are used up' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.id_credit_ledger (kind, credits, reserved_delta, member_user_id, note)
  VALUES ('charge', -s.cost_per_check, CASE WHEN v_from_reserve THEN -s.cost_per_check ELSE 0 END, p_member,
          CASE WHEN v_from_reserve THEN 'ID check (imported member, from reserve)' ELSE 'ID check' END);
  PERFORM public._id_credit_maybe_alert(NULL);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public._id_credit_charge(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._id_credit_charge(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public._id_credit_on_submission()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'pending' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'pending') THEN
    PERFORM public._id_credit_charge(NEW.user_id);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._id_credit_on_submission() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER customer_verification_id_credit
  AFTER INSERT OR UPDATE OF status ON public.customer_verification
  FOR EACH ROW EXECUTE FUNCTION public._id_credit_on_submission();

-- Balance and the latest 25 movements for /admin → ID checks. No member names.
CREATE OR REPLACE FUNCTION public.id_credits_summary(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  s public.id_credit_settings;
  b record;
  v_used_30 integer;
  v_recent jsonb;
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender'::public.app_role);
  SELECT * INTO s FROM public.id_credit_settings WHERE id;
  SELECT * INTO b FROM public._id_credit_balance();
  SELECT COALESCE(-sum(credits), 0)::integer INTO v_used_30 FROM public.id_credit_ledger
  WHERE kind = 'charge' AND created_at > now() - interval '30 days';
  SELECT COALESCE(jsonb_agg(r ORDER BY r.created_at DESC, r.id DESC), '[]'::jsonb) INTO v_recent FROM (
    SELECT id, kind, credits, reserved_delta, note, created_at FROM public.id_credit_ledger
    ORDER BY created_at DESC, id DESC LIMIT 25) r;
  RETURN jsonb_build_object(
    'total', b.total, 'reserved', b.reserved, 'available', b.available,
    'cost_per_check', s.cost_per_check, 'low_balance_threshold', s.low_balance_threshold,
    'checks_left', CASE WHEN s.cost_per_check > 0 THEN GREATEST(b.available, 0) / s.cost_per_check END,
    'reserved_checks_left', CASE WHEN s.cost_per_check > 0 THEN GREATEST(b.reserved, 0) / s.cost_per_check END,
    'used_last_30_days', v_used_30,
    'charged_members', (SELECT count(*) FROM public.id_credit_ledger WHERE kind = 'charge'),
    'low_alert_sent_at', s.low_alert_sent_at,
    'alert_emails', to_jsonb(s.alert_emails),
    'recent', v_recent);
END;
$$;
REVOKE ALL ON FUNCTION public.id_credits_summary(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.id_credits_summary(uuid) TO service_role;

-- Any staff member records credits bought from the provider.
CREATE OR REPLACE FUNCTION public.id_credits_top_up(p_actor uuid, p_credits integer, p_note text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  s public.id_credit_settings;
  b record;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'budtender'::public.app_role);
  v_cached := public._idem_begin('id_credits_top_up', p_actor, p_idempotency_key,
    jsonb_build_object('credits', p_credits, 'note', v_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_credits IS NULL OR p_credits NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'invalid_amount: top up between 1 and 100 000 credits';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 200 THEN RAISE EXCEPTION 'invalid_input: note too long'; END IF;
  SELECT * INTO s FROM public.id_credit_settings WHERE id FOR UPDATE;
  INSERT INTO public.id_credit_ledger (kind, credits, actor_user_id, note)
  VALUES ('top_up', p_credits, p_actor, COALESCE(v_note, 'Top-up'));
  SELECT * INTO b FROM public._id_credit_balance();
  IF b.available > s.low_balance_threshold THEN
    UPDATE public.id_credit_settings SET low_alert_sent_at = NULL, updated_at = now() WHERE id;
  END IF;
  PERFORM public._audit(p_actor, 'id_credits_topped_up', 'id_credits', NULL,
    jsonb_build_object('credits', p_credits, 'available', b.available));
  v_response := jsonb_build_object('total', b.total, 'reserved', b.reserved, 'available', b.available);
  RETURN public._idem_finish('id_credits_top_up', p_actor, p_idempotency_key, v_response);
END;
$$;
REVOKE ALL ON FUNCTION public.id_credits_top_up(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.id_credits_top_up(uuid, integer, text, text) TO service_role;

-- Admin changes how many credits are held back for imported members (e.g. releases what the import did not use).
CREATE OR REPLACE FUNCTION public.id_credits_set_reserve(p_actor uuid, p_reserved integer, p_note text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  b record;
  v_delta integer;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  v_cached := public._idem_begin('id_credits_reserve', p_actor, p_idempotency_key,
    jsonb_build_object('reserved', p_reserved, 'note', v_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  PERFORM 1 FROM public.id_credit_settings WHERE id FOR UPDATE;
  SELECT * INTO b FROM public._id_credit_balance();
  IF p_reserved IS NULL OR p_reserved < 0 OR p_reserved > GREATEST(b.total, 0) THEN
    RAISE EXCEPTION 'invalid_amount: the reserve must be between 0 and the % credits in the balance', GREATEST(b.total, 0);
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 200 THEN RAISE EXCEPTION 'invalid_input: note too long'; END IF;
  v_delta := p_reserved - b.reserved;
  IF v_delta <> 0 THEN
    INSERT INTO public.id_credit_ledger (kind, credits, reserved_delta, actor_user_id, note)
    VALUES (CASE WHEN v_delta > 0 THEN 'reserve' ELSE 'release' END, 0, v_delta, p_actor,
            COALESCE(v_note, CASE WHEN v_delta > 0 THEN 'Reserve increased' ELSE 'Reserve released' END));
    PERFORM public._audit(p_actor, 'id_credits_reserve_set', 'id_credits', NULL,
      jsonb_build_object('from', b.reserved, 'to', p_reserved));
    PERFORM public._id_credit_maybe_alert(p_actor);
  END IF;
  SELECT * INTO b FROM public._id_credit_balance();
  v_response := jsonb_build_object('total', b.total, 'reserved', b.reserved, 'available', b.available);
  RETURN public._idem_finish('id_credits_reserve', p_actor, p_idempotency_key, v_response);
END;
$$;
REVOKE ALL ON FUNCTION public.id_credits_set_reserve(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.id_credits_set_reserve(uuid, integer, text, text) TO service_role;

-- Whether a new member can be ID-checked right now. Only a yes/no leaves the database (shown on the sign-up form).
CREATE OR REPLACE FUNCTION public.id_credits_open()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT b.available >= s.cost_per_check
  FROM public._id_credit_balance() b, public.id_credit_settings s WHERE s.id;
$$;
REVOKE ALL ON FUNCTION public.id_credits_open() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.id_credits_open() TO service_role;

-- Charge the members who signed up since 26 Oct 2026 00:00 SAST (owner's instruction). Staff accounts are not members.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT u.id FROM auth.users u
    WHERE u.created_at >= timestamptz '2026-10-26 00:00:00+02'
      AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = u.id
                      AND ur.role IN ('budtender', 'manager', 'admin'))
    ORDER BY u.created_at
  LOOP
    PERFORM public._id_credit_charge(r.id);
  END LOOP;
END;
$$;
