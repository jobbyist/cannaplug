-- Rollback for 20261030001000_customer_import: no imported-member tables, no claim trigger, no daily invitations, no
-- 'provisional' status, usernames back to the 3-20 a-z 0-9 _ format. Imported accounts that already exist stay in
-- auth.users (they are people); their provisional status becomes 'unverified' and usernames the old format cannot hold
-- are cleared. Earlier function definitions are restored as they were.
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cannaplug-import-invites';
  END IF;
END;
$$;
DROP TRIGGER IF EXISTS customer_import_claim ON auth.users;
DROP FUNCTION IF EXISTS public._import_claim();
DROP FUNCTION IF EXISTS public.import_invites_run(timestamptz, integer);
DROP FUNCTION IF EXISTS public.import_customers(uuid, text, text, jsonb, text);
DROP FUNCTION IF EXISTS public._import_insert_auth_user(text, jsonb);
DROP FUNCTION IF EXISTS public.username_check_signup(text, text);
DROP FUNCTION IF EXISTS public.member_username_change_state(uuid);
DROP TABLE IF EXISTS public.imported_customers;
DROP TABLE IF EXISTS public.customer_imports;

UPDATE public.customer_verification SET status = 'unverified', method = NULL, updated_at = now() WHERE status = 'provisional';
ALTER TABLE public.customer_verification DROP CONSTRAINT IF EXISTS customer_verification_status_check;
ALTER TABLE public.customer_verification ADD CONSTRAINT customer_verification_status_check
  CHECK (status IN ('unverified', 'pending', 'verified', 'rejected', 'expired'));

UPDATE public.profiles SET username = NULL WHERE username IS NOT NULL AND username !~ '^[a-z0-9_]{3,20}$';
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_username_format;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_username_format CHECK (username IS NULL OR username ~ '^[a-z0-9_]{3,20}$');
UPDATE public.member_signup_details SET referral_code = NULL WHERE referral_code !~ '^[A-Z0-9_-]{3,32}$';
ALTER TABLE public.member_signup_details DROP CONSTRAINT IF EXISTS member_signup_details_referral_code_check;
ALTER TABLE public.member_signup_details ADD CONSTRAINT member_signup_details_referral_code_check
  CHECK (referral_code IS NULL OR referral_code ~ '^[A-Z0-9_-]{3,32}$');

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
  -- Staff accounts are exempt from the online ID check.
  IF public._is_staff(p_user_id) THEN
    RETURN;
  END IF;
  SELECT cv.status, cv.document_expires_on INTO v_status, v_expires
  FROM public.customer_verification cv WHERE cv.user_id = p_user_id;
  IF v_status = 'verified' THEN
    -- SA IDs never expire (document_expires_on is NULL); passports and driver's licences do.
    IF v_expires IS NOT NULL AND v_expires < current_date THEN
      RAISE EXCEPTION 'verification_expired: your ID document has expired — upload a current one to keep ordering';
    END IF;
    RETURN;
  ELSIF v_status = 'pending' THEN
    RAISE EXCEPTION 'verification_pending: your ID is being reviewed — you can order once it is approved';
  END IF;
  RAISE EXCEPTION 'verification_required: verify your ID before placing an order';
END;
$$;

CREATE OR REPLACE FUNCTION public.referral_code_check(p_code text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v text := lower(btrim(COALESCE(p_code, '')));
  v_id uuid;
BEGIN
  IF v !~ '^[a-z0-9_-]{3,32}$' THEN RETURN jsonb_build_object('valid', false, 'reason', 'invalid'); END IF;
  SELECT p.id INTO v_id FROM public.profiles p WHERE p.username = v;
  IF v_id IS NULL THEN RETURN jsonb_build_object('valid', false, 'reason', 'not_found'); END IF;
  IF NOT public._referral_eligible(v_id) THEN RETURN jsonb_build_object('valid', false, 'reason', 'inactive'); END IF;
  RETURN jsonb_build_object('valid', true, 'code', v);
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id text := upper(regexp_replace(COALESCE(NEW.raw_user_meta_data ->> 'id_number', ''), '[\s-]', '', 'g'));
  v_ref text := upper(btrim(COALESCE(NEW.raw_user_meta_data ->> 'referral_code', '')));
  v_user text := lower(btrim(COALESCE(NEW.raw_user_meta_data ->> 'username', '')));
  v_referrer uuid;
BEGIN
  IF NOT (v_user ~ '^[a-z0-9_]{3,20}$') OR public._username_reserved(v_user) THEN v_user := NULL; END IF;
  BEGIN
  INSERT INTO public.profiles (id, full_name, first_name, last_name, phone, date_of_birth, address, username)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data ->> 'full_name',
    NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'first_name', '')), ''),
    NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'last_name', '')), ''),
    NEW.raw_user_meta_data ->> 'phone',
    NULLIF(NEW.raw_user_meta_data ->> 'date_of_birth', '')::date,
    NEW.raw_user_meta_data ->> 'address',
    v_user
  )
  ON CONFLICT (id) DO NOTHING;
  EXCEPTION WHEN unique_violation THEN
    -- The username was taken a moment ago: keep the account, leave the username empty (asked for again in the portal).
    INSERT INTO public.profiles (id, full_name, first_name, last_name, phone, date_of_birth, address)
    VALUES (
      NEW.id,
      NEW.raw_user_meta_data ->> 'full_name',
      NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'first_name', '')), ''),
      NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'last_name', '')), ''),
      NEW.raw_user_meta_data ->> 'phone',
      NULLIF(NEW.raw_user_meta_data ->> 'date_of_birth', '')::date,
      NEW.raw_user_meta_data ->> 'address')
    ON CONFLICT (id) DO NOTHING;
  END;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'customer'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  IF v_id ~ '^[A-Z0-9]{6,20}$' OR v_ref ~ '^[A-Z0-9_-]{3,32}$' THEN
    INSERT INTO public.member_signup_details (user_id, id_number, referral_code)
    VALUES (NEW.id,
            CASE WHEN v_id ~ '^[A-Z0-9]{6,20}$' THEN v_id END,
            CASE WHEN v_ref ~ '^[A-Z0-9_-]{3,32}$' THEN v_ref END)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  -- A referral code is the referring member's username. The friend is recorded as pending; the referrer earns their
  -- point when the friend has spent R50 (see _referral_check). Never raises: a bad code simply records nothing.
  IF v_ref ~ '^[A-Z0-9_-]{3,32}$' THEN
    BEGIN
      SELECT p.id INTO v_referrer FROM public.profiles p WHERE p.username = lower(v_ref) AND p.id <> NEW.id;
      IF v_referrer IS NOT NULL AND public._referral_eligible(v_referrer) THEN
        INSERT INTO public.referrals (referrer_id, referee_id, code)
        VALUES (v_referrer, NEW.id, lower(v_ref))
        ON CONFLICT (referee_id) DO NOTHING;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  IF NEW.raw_user_meta_data ? 'id_number' OR NEW.raw_user_meta_data ? 'referral_code' OR NEW.raw_user_meta_data ? 'username' THEN
    UPDATE auth.users
    SET raw_user_meta_data = raw_user_meta_data - 'id_number' - 'referral_code' - 'username'
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.member_set_username(p_user_id uuid, p_username text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v text := lower(btrim(COALESCE(p_username, '')));
  v_status text;
  v_current text;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'forbidden: sign in to choose a username' USING ERRCODE = '42501';
  END IF;
  v_cached := public._idem_begin('member_username', p_user_id, p_idempotency_key, jsonb_build_object('u', v));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  SELECT p.username INTO v_current FROM public.profiles p WHERE p.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
  IF v_current IS NOT NULL THEN
    RAISE EXCEPTION 'username_already_set: your username is your referral code, so it cannot be changed';
  END IF;
  v_status := public.username_check(v);
  IF v_status <> 'ok' THEN RAISE EXCEPTION 'username_%: %', v_status, v; END IF;
  BEGIN
    UPDATE public.profiles SET username = v, updated_at = now() WHERE id = p_user_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'username_taken: %', v;
  END;
  PERFORM public._audit(p_user_id, 'member_username_set', 'profile', p_user_id, jsonb_build_object('username', v));
  v_response := jsonb_build_object('username', v);
  RETURN public._idem_finish('member_username', p_user_id, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public._email_tier(p_template text)
RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_template IN ('staff_id_review', 'id_submitted') THEN 0
    WHEN p_template IN ('promo_announcement', 'journal_digest') THEN 3
    WHEN p_template IN ('staff_low_stock', 'back_in_stock', 'id_expiring', 'newsletter_welcome',
                        'contact_form_ack', 'id_approved') THEN 2
    ELSE 1
  END;
$$;

CREATE OR REPLACE FUNCTION public.pos_customer_search(p_actor uuid, p_search text, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_q text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_pat text;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 6), 1), 20);
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  IF v_q IS NULL OR length(v_q) < 2 OR length(v_q) > 100 THEN RETURN '[]'::jsonb; END IF;
  v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', x.id, 'full_name', x.full_name, 'phone', x.phone, 'email', x.email,
                                        'username', x.username, 'is_staff', x.is_staff, 'can_attach', x.can_attach, 'blocked_reason', x.blocked_reason) ORDER BY x.is_staff, x.full_name NULLS LAST, x.id)
    FROM (
      SELECT u.id, p.full_name, p.phone, u.email, p.username, public._is_staff(u.id) AS is_staff,
             (NOT public._is_staff(u.id) OR public._pos_can_attach_staff(p_actor, u.id)) AS can_attach,
             CASE WHEN NOT public._is_staff(u.id) OR public._pos_can_attach_staff(p_actor, u.id) THEN NULL
                  WHEN u.id = p_actor THEN 'You cannot give yourself the staff rate on your own till sale'
                  ELSE 'Only a manager or admin can attach this staff member' END AS blocked_reason
      FROM auth.users u
      LEFT JOIN public.profiles p ON p.id = u.id
      WHERE EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = u.id)
        AND (p.full_name ILIKE v_pat OR p.phone ILIKE v_pat OR u.email ILIKE v_pat OR p.username ILIKE v_pat)
      ORDER BY p.full_name NULLS LAST, u.id
      LIMIT v_limit) x), '[]'::jsonb);
END;
$fn$;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['_require_verified_member', 'referral_code_check', 'handle_new_user',
      'member_set_username', '_email_tier', 'pos_customer_search'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;
