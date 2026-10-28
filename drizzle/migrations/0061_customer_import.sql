-- 30 Oct 2026: import of customers from the previous platform (Clinify) as provisionally approved members.
--   Owner's decisions (28 Oct 2026): the first 186 members of the customer export become Cannaplug customers with their ID
--   verification set to PROVISIONAL (they already submitted their ID on the previous platform). They can shop in store
--   straight away. To use the online store they sign up with their email, set their own password and submit their ID /
--   passport for review (POPIA). A daily job emails the invitation, 20 members a day, until all have been invited.
--
--   * customer_verification.status gains 'provisional'. The online gate (_require_verified_member) refuses it with
--     verification_provisional; the till treats the member like any other customer; a submitted ID moves it to pending.
--   * imported_customers: one row per imported member (member number, invite and claim dates, whether the one username
--     change was used). customer_imports: one row per import batch (file hash, counts). RLS on, service role only.
--     No ID, health or contact data is kept here; the name, phone and email live on the profile / auth user as for any member.
--   * import_customers (admin): creates the unconfirmed account (no password; app_metadata source = customer_import, which
--     only the server can set), the profile with the username from the file, the customer role, and the provisional
--     verification. Refuses under-18s (the export lists ages), existing emails, taken usernames. Idempotent per batch + key.
--   * Sign-up with an imported email "claims" the account: the account's metadata then carries the ID / passport number,
--     which _import_claim moves into the locked member_signup_details table, and the member is charged 3 ID-check credits
--     from the 558 reserved for the import, even if no photo of the ID is ever uploaded. The later ID submission is free
--     (one charge per member).
--   * Usernames from the file may contain dots and be up to 32 characters (e.g. phenyo.kgwadi); the profile format check,
--     referral codes and links accept dots. New usernames chosen by members keep the stricter 3-20 of a-z 0-9 _ rule.
--     An imported member may change their username ONCE, after they have submitted their ID (pending or verified).
--   * import_invites_run: once a day (pg_cron, 08:00 SAST) queues the invitation email for the next 20 members who are not
--     held, not invited and have not signed up yet. Never more than 20 in a SAST day. The email dispatcher and the daily
--     email budget (Resend free plan) apply as for every email. Members whose email address in the file looked mistyped
--     are held (invite_hold) until the owner confirms the address.
--   Every function: SECURITY DEFINER, search_path '', explicit actor where there is one, idempotency key, audit row,
--   service role only. The file's data is NOT in this migration; the rows are supplied when an admin runs the import.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Provisional status
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE public.customer_verification DROP CONSTRAINT IF EXISTS customer_verification_status_check;
ALTER TABLE public.customer_verification ADD CONSTRAINT customer_verification_status_check
  CHECK (status IN ('unverified', 'pending', 'verified', 'rejected', 'expired', 'provisional'));

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
  ELSIF v_status = 'provisional' THEN
    RAISE EXCEPTION 'verification_provisional: your account is active in store. Submit your ID to unlock the online store';
  ELSIF v_status = 'pending' THEN
    RAISE EXCEPTION 'verification_pending: your ID is being reviewed — you can order once it is approved';
  END IF;
  RAISE EXCEPTION 'verification_required: verify your ID before placing an order';
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Usernames and referral codes may contain dots (imported usernames look like first.last)
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_username_format;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_username_format
  CHECK (username IS NULL OR username ~ '^[a-z0-9_.]{3,32}$');
ALTER TABLE public.member_signup_details DROP CONSTRAINT IF EXISTS member_signup_details_referral_code_check;
ALTER TABLE public.member_signup_details ADD CONSTRAINT member_signup_details_referral_code_check
  CHECK (referral_code IS NULL OR referral_code ~ '^[A-Z0-9_.-]{3,32}$');

CREATE OR REPLACE FUNCTION public.referral_code_check(p_code text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v text := lower(btrim(COALESCE(p_code, '')));
  v_id uuid;
BEGIN
  IF v !~ '^[a-z0-9_.-]{3,32}$' THEN RETURN jsonb_build_object('valid', false, 'reason', 'invalid'); END IF;
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

  IF v_id ~ '^[A-Z0-9]{6,20}$' OR v_ref ~ '^[A-Z0-9_.-]{3,32}$' THEN
    INSERT INTO public.member_signup_details (user_id, id_number, referral_code)
    VALUES (NEW.id,
            CASE WHEN v_id ~ '^[A-Z0-9]{6,20}$' THEN v_id END,
            CASE WHEN v_ref ~ '^[A-Z0-9_.-]{3,32}$' THEN v_ref END)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  -- A referral code is the referring member's username. The friend is recorded as pending; the referrer earns their
  -- point when the friend has spent R50 (see _referral_check). Never raises: a bad code simply records nothing.
  IF v_ref ~ '^[A-Z0-9_.-]{3,32}$' THEN
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

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch text NOT NULL UNIQUE CHECK (batch ~ '^[a-z0-9_-]{3,60}$'),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  rows_received integer NOT NULL,
  rows_imported integer NOT NULL,
  rows_skipped integer NOT NULL,
  imported_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.imported_customers (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  batch text NOT NULL REFERENCES public.customer_imports(batch),
  member_number integer NOT NULL CHECK (member_number > 0),
  -- Why no invitation is sent yet (e.g. the email address in the file looked mistyped). NULL = may be invited.
  invite_hold text CHECK (invite_hold IS NULL OR length(invite_hold) <= 120),
  invited_at timestamptz,
  claimed_at timestamptz,
  username_edit_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_number)
);
CREATE INDEX IF NOT EXISTS imported_customers_invite_idx ON public.imported_customers (member_number)
  WHERE invited_at IS NULL AND claimed_at IS NULL AND invite_hold IS NULL;

ALTER TABLE public.customer_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imported_customers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_imports, public.imported_customers FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.customer_imports, public.imported_customers TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. The import
-- ---------------------------------------------------------------------------------------------------------------
-- Creates the unconfirmed, password-less account the way GoTrue would (columns that do not exist in the local test stub
-- are skipped). Returns the new user's id.
CREATE OR REPLACE FUNCTION public._import_insert_auth_user(p_email text, p_user_meta jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_set text;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  VALUES (v_id, p_email, p_user_meta,
          jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'source', 'customer_import'));
  SELECT string_agg(format('%I = %L', c.column_name, d.val), ', ') INTO v_set
  FROM (VALUES ('instance_id', '00000000-0000-0000-0000-000000000000'), ('aud', 'authenticated'),
               ('role', 'authenticated'), ('encrypted_password', ''), ('confirmation_token', ''),
               ('recovery_token', ''), ('email_change_token_new', ''), ('email_change', ''),
               ('email_change_token_current', ''), ('phone_change', ''), ('phone_change_token', ''),
               ('reauthentication_token', '')) AS d(col, val)
  JOIN information_schema.columns c
    ON c.table_schema = 'auth' AND c.table_name = 'users' AND c.column_name = d.col;
  IF v_set IS NOT NULL THEN
    EXECUTE 'UPDATE auth.users SET ' || v_set || ' WHERE id = $1' USING v_id;
  END IF;
  IF to_regclass('auth.identities') IS NOT NULL THEN
    EXECUTE 'INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
             VALUES ($1, $1, $2, ''email'', now(), now())'
      USING v_id::text, jsonb_build_object('sub', v_id::text, 'email', p_email, 'email_verified', false,
                                           'phone_verified', false);
  END IF;
  RETURN v_id;
END;
$$;

-- p_rows: [{member_number, first_name, last_name, email, phone, username, age, hold?}]. Returns counts and, for every
-- skipped row, its member number and the reason (no names or emails).
CREATE OR REPLACE FUNCTION public.import_customers(
  p_actor uuid, p_batch text, p_file_sha256 text, p_rows jsonb, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  r jsonb;
  v_email text;
  v_user text;
  v_first text;
  v_last text;
  v_num integer;
  v_age integer;
  v_id uuid;
  v_imported integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_reason text;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  v_cached := public._idem_begin('customer_import', p_actor, p_idempotency_key,
    jsonb_build_object('batch', p_batch, 'sha', p_file_sha256));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_batch IS NULL OR p_batch !~ '^[a-z0-9_-]{3,60}$' THEN RAISE EXCEPTION 'invalid_input: batch name'; END IF;
  IF p_file_sha256 IS NULL OR p_file_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_input: file hash'; END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_input: send between 1 and 500 rows';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customer_imports WHERE batch = p_batch) THEN
    RAISE EXCEPTION 'import_already_done: batch % was already imported', p_batch;
  END IF;
  INSERT INTO public.customer_imports (batch, file_sha256, rows_received, rows_imported, rows_skipped, imported_by)
  VALUES (p_batch, p_file_sha256, jsonb_array_length(p_rows), 0, 0, p_actor);

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_reason := NULL;
    v_num := NULLIF(r->>'member_number', '')::integer;
    v_email := lower(btrim(COALESCE(r->>'email', '')));
    v_user := lower(btrim(COALESCE(r->>'username', '')));
    v_first := btrim(COALESCE(r->>'first_name', ''));
    v_last := btrim(COALESCE(r->>'last_name', ''));
    v_age := NULLIF(r->>'age', '')::integer;
    IF v_num IS NULL OR v_num < 1 THEN
      v_reason := 'invalid_member_number';
    ELSIF v_age IS NULL OR v_age < 18 THEN
      v_reason := 'underage_or_unknown_age';          -- cannabis is for adults: never provisionally approve a minor
    ELSIF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(v_email) > 254 THEN
      v_reason := 'invalid_email';
    ELSIF v_user !~ '^[a-z0-9_.]{3,32}$' OR public._username_reserved(v_user) THEN
      v_reason := 'invalid_username';
    ELSIF v_first = '' OR v_last = '' OR length(v_first) > 80 OR length(v_last) > 80 THEN
      v_reason := 'invalid_name';
    ELSIF EXISTS (SELECT 1 FROM public.imported_customers ic WHERE ic.member_number = v_num) THEN
      v_reason := 'already_imported';
    ELSIF EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = v_email) THEN
      v_reason := 'email_exists';
    ELSIF EXISTS (SELECT 1 FROM public.profiles p WHERE p.username = v_user) THEN
      v_reason := 'username_taken';
    END IF;
    IF v_reason IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('member_number', v_num, 'reason', v_reason));
      CONTINUE;
    END IF;

    v_id := public._import_insert_auth_user(v_email, jsonb_build_object(
      'first_name', v_first, 'last_name', v_last, 'full_name', v_first || ' ' || v_last,
      'phone', NULLIF(btrim(COALESCE(r->>'phone', '')), '')));
    -- handle_new_user made the profile and the customer role; the file's username goes on the profile.
    UPDATE public.profiles SET username = v_user, updated_at = now() WHERE id = v_id;
    INSERT INTO public.customer_verification (user_id, status, method, metadata)
    VALUES (v_id, 'provisional', 'customer_import', jsonb_build_object('source', 'clinify', 'batch', p_batch))
    ON CONFLICT (user_id) DO NOTHING;
    INSERT INTO public.imported_customers (user_id, batch, member_number, invite_hold)
    VALUES (v_id, p_batch, v_num, NULLIF(btrim(COALESCE(r->>'hold', '')), ''));
    v_imported := v_imported + 1;
  END LOOP;

  UPDATE public.customer_imports
  SET rows_imported = v_imported, rows_skipped = jsonb_array_length(v_skipped) WHERE batch = p_batch;
  PERFORM public._audit(p_actor, 'customers_imported', 'customer_import', NULL,
    jsonb_build_object('batch', p_batch, 'file_sha256', p_file_sha256, 'imported', v_imported,
                       'skipped', jsonb_array_length(v_skipped)));
  v_response := jsonb_build_object('batch', p_batch, 'imported', v_imported, 'skipped', v_skipped);
  RETURN public._idem_finish('customer_import', p_actor, p_idempotency_key, v_response);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Sign-up claims the account; the ID / passport number costs 3 credits from the reserve
-- ---------------------------------------------------------------------------------------------------------------
-- Sign-up with an imported email updates the existing account (new password + the sign-up form's metadata) instead of
-- creating one, so handle_new_user does not run. This does its work: store the ID number in the locked table, keep
-- the file's username, record the sign-up details, charge the ID-check credits.
CREATE OR REPLACE FUNCTION public._import_claim()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id text := upper(regexp_replace(COALESCE(NEW.raw_user_meta_data ->> 'id_number', ''), '[\s-]', '', 'g'));
  v_ref text := upper(btrim(COALESCE(NEW.raw_user_meta_data ->> 'referral_code', '')));
  v_first text := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'first_name', '')), '');
  v_last text := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'last_name', '')), '');
  v_phone text := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'phone', '')), '');
  v_dob date;
  v_imp public.imported_customers;
BEGIN
  IF v_id !~ '^[A-Z0-9]{6,20}$' THEN RETURN NULL; END IF;
  SELECT * INTO v_imp FROM public.imported_customers WHERE user_id = NEW.id AND claimed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  BEGIN
    v_dob := NULLIF(NEW.raw_user_meta_data ->> 'date_of_birth', '')::date;
  EXCEPTION WHEN OTHERS THEN
    v_dob := NULL;
  END;
  INSERT INTO public.member_signup_details (user_id, id_number, referral_code)
  VALUES (NEW.id, v_id, CASE WHEN v_ref ~ '^[A-Z0-9_.-]{3,32}$' THEN v_ref END)
  ON CONFLICT (user_id) DO UPDATE SET id_number = EXCLUDED.id_number, referral_code = EXCLUDED.referral_code;
  UPDATE public.profiles
  SET first_name = COALESCE(v_first, first_name), last_name = COALESCE(v_last, last_name),
      full_name = COALESCE(NULLIF(btrim(COALESCE(v_first, first_name, '') || ' ' || COALESCE(v_last, last_name, '')), ''), full_name),
      phone = COALESCE(v_phone, phone), date_of_birth = COALESCE(v_dob, date_of_birth), updated_at = now()
  WHERE id = NEW.id;
  UPDATE public.imported_customers SET claimed_at = now() WHERE user_id = NEW.id;
  -- Charged now, because the member has given their ID number; a photo is not needed. Imported members come out of
  -- the reserve while it lasts. Refuses with id_credits_depleted when nothing is left.
  PERFORM public._id_credit_charge(NEW.id);
  -- The number must not stay in the account's own metadata (it would travel in the session token).
  UPDATE auth.users
  SET raw_user_meta_data = raw_user_meta_data - 'id_number' - 'referral_code' - 'username'
  WHERE id = NEW.id;
  PERFORM public._audit(NEW.id, 'customer_import_claimed', 'user', NEW.id,
    jsonb_build_object('member_number', v_imp.member_number));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS customer_import_claim ON auth.users;
CREATE TRIGGER customer_import_claim AFTER UPDATE OF raw_user_meta_data ON auth.users
  FOR EACH ROW WHEN (NEW.raw_app_meta_data ->> 'source' = 'customer_import' AND NEW.raw_user_meta_data ? 'id_number')
  EXECUTE FUNCTION public._import_claim();

-- The sign-up form asks whether a username is free. An imported member's own username (with their own email) is fine.
CREATE OR REPLACE FUNCTION public.username_check_signup(p_email text, p_username text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v text := lower(btrim(COALESCE(p_username, '')));
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.imported_customers ic
    JOIN auth.users u ON u.id = ic.user_id
    JOIN public.profiles p ON p.id = ic.user_id
    WHERE ic.claimed_at IS NULL AND lower(u.email) = lower(btrim(COALESCE(p_email, ''))) AND p.username = v) THEN
    RETURN 'ok';
  END IF;
  RETURN public.username_check(v);
END;
$$;

-- A member adds their username once. It is also their referral code, so it cannot be changed afterwards - except for
-- an imported member, who may change the username from the file ONCE, after they have submitted their ID.
CREATE OR REPLACE FUNCTION public.member_set_username(p_user_id uuid, p_username text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v text := lower(btrim(COALESCE(p_username, '')));
  v_status text;
  v_current text;
  v_imp public.imported_customers;
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
    SELECT * INTO v_imp FROM public.imported_customers WHERE user_id = p_user_id AND claimed_at IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'username_already_set: your username is your referral code, so it cannot be changed';
    END IF;
    IF v_imp.username_edit_used_at IS NOT NULL THEN
      RAISE EXCEPTION 'username_already_set: you have already used your one username change';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.customer_verification cv
                   WHERE cv.user_id = p_user_id AND cv.status IN ('pending', 'verified')) THEN
      RAISE EXCEPTION 'username_edit_needs_id: submit your ID for verification to change your username';
    END IF;
    IF v = v_current THEN RAISE EXCEPTION 'username_unchanged: that is already your username'; END IF;
  END IF;
  v_status := public.username_check(v);
  IF v_status <> 'ok' THEN RAISE EXCEPTION 'username_%: %', v_status, v; END IF;
  BEGIN
    UPDATE public.profiles SET username = v, updated_at = now() WHERE id = p_user_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'username_taken: %', v;
  END;
  IF v_current IS NOT NULL THEN
    UPDATE public.imported_customers SET username_edit_used_at = now() WHERE user_id = p_user_id;
  END IF;
  PERFORM public._audit(p_user_id, CASE WHEN v_current IS NULL THEN 'member_username_set' ELSE 'member_username_changed' END,
    'profile', p_user_id, jsonb_build_object('username', v) || CASE WHEN v_current IS NULL THEN '{}'::jsonb
                                                                    ELSE jsonb_build_object('previous', v_current) END);
  v_response := jsonb_build_object('username', v);
  RETURN public._idem_finish('member_username', p_user_id, p_idempotency_key, v_response);
END;
$$;

-- Whether the signed-in member may still change their imported username (for the account page).
CREATE OR REPLACE FUNCTION public.member_username_change_state(p_user_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
    WHEN ic.user_id IS NULL OR ic.claimed_at IS NULL THEN 'none'
    WHEN ic.username_edit_used_at IS NOT NULL THEN 'used'
    WHEN EXISTS (SELECT 1 FROM public.customer_verification cv
                 WHERE cv.user_id = p_user_id AND cv.status IN ('pending', 'verified')) THEN 'available'
    ELSE 'needs_id'
  END
  FROM (SELECT 1) x LEFT JOIN public.imported_customers ic ON ic.user_id = p_user_id;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. The invitation email: 20 members a day
-- ---------------------------------------------------------------------------------------------------------------
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

CREATE OR REPLACE FUNCTION public.import_invites_run(p_now timestamptz DEFAULT now(), p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c_daily_max constant integer := 20;
  v_day_start timestamptz := date_trunc('day', p_now AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg';
  v_done_today integer;
  v_room integer;
  r record;
  v_queued integer := 0;
BEGIN
  -- One run at a time, so two overlapping runs cannot both fill the day.
  PERFORM pg_advisory_xact_lock(hashtext('import_invites_run'));
  SELECT count(*) INTO v_done_today FROM public.imported_customers
  WHERE invited_at >= v_day_start AND invited_at < v_day_start + interval '1 day';
  v_room := GREATEST(LEAST(COALESCE(p_limit, c_daily_max), c_daily_max) - v_done_today, 0);
  IF v_room > 0 THEN
    FOR r IN
      SELECT ic.user_id, u.email, p.first_name, p.username
      FROM public.imported_customers ic
      JOIN auth.users u ON u.id = ic.user_id
      LEFT JOIN public.profiles p ON p.id = ic.user_id
      WHERE ic.invited_at IS NULL AND ic.claimed_at IS NULL AND ic.invite_hold IS NULL AND u.email IS NOT NULL
      ORDER BY ic.member_number
      LIMIT v_room
      FOR UPDATE OF ic SKIP LOCKED
    LOOP
      PERFORM public.notification_enqueue('email', 'member_import_invite', r.email, r.user_id, 'transactional',
        jsonb_build_object('first_name', r.first_name, 'username', r.username),
        'import-invite:' || r.user_id::text);
      UPDATE public.imported_customers SET invited_at = p_now WHERE user_id = r.user_id;
      v_queued := v_queued + 1;
    END LOOP;
    IF v_queued > 0 THEN
      PERFORM public._audit(NULL, 'import_invites_queued', 'customer_import', NULL,
        jsonb_build_object('queued', v_queued, 'left', (SELECT count(*) FROM public.imported_customers ic
          WHERE ic.invited_at IS NULL AND ic.claimed_at IS NULL AND ic.invite_hold IS NULL)));
    END IF;
  END IF;
  RETURN jsonb_build_object('queued', v_queued, 'already_today', v_done_today);
END;
$$;

DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cannaplug-import-invites';
    -- 06:00 UTC = 08:00 SAST, every day; it does nothing once everybody has been invited.
    PERFORM cron.schedule('cannaplug-import-invites', '0 6 * * *', $c$SELECT public.import_invites_run()$c$);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. The till shows the ID status next to each customer
-- ---------------------------------------------------------------------------------------------------------------
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
                                        'username', x.username, 'id_status', x.id_status, 'is_staff', x.is_staff, 'can_attach', x.can_attach, 'blocked_reason', x.blocked_reason) ORDER BY x.is_staff, x.full_name NULLS LAST, x.id)
    FROM (
      SELECT u.id, p.full_name, p.phone, u.email, p.username, public._is_staff(u.id) AS is_staff,
             (SELECT cv.status FROM public.customer_verification cv WHERE cv.user_id = u.id) AS id_status,
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

-- ---------------------------------------------------------------------------------------------------------------
-- 8. Permissions: the server (service role) only
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
      '_require_verified_member', 'referral_code_check', 'handle_new_user', '_import_insert_auth_user',
      'import_customers', '_import_claim', 'username_check_signup', 'member_set_username',
      'member_username_change_state', '_email_tier', 'import_invites_run',
      'pos_customer_search'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;
