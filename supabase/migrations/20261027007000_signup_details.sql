-- 27 Oct 2026: sign-up collects first name, surname, phone, ID/passport number and an optional referral code.
--   * profiles gets first_name and last_name (full_name stays, as "First Last").
--   * member_signup_details holds the ID/passport number and referral code. RLS is on with no policies and no
--     browser grants: only the service role can read it. The number is never put in emails, logs or analytics.
--   * handle_new_user copies the sign-up data, then removes id_number and referral_code from the account's own
--     user metadata so they are not carried in the member's session token. It never raises: accounts created
--     another way (staff, imports) simply have no details.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text;

CREATE TABLE IF NOT EXISTS public.member_signup_details (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  id_number text CHECK (id_number IS NULL OR id_number ~ '^[A-Z0-9]{6,20}$'),
  referral_code text CHECK (referral_code IS NULL OR referral_code ~ '^[A-Z0-9-]{3,32}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_signup_details ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_signup_details FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.member_signup_details TO service_role;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id text := upper(regexp_replace(COALESCE(NEW.raw_user_meta_data ->> 'id_number', ''), '[\s-]', '', 'g'));
  v_ref text := upper(btrim(COALESCE(NEW.raw_user_meta_data ->> 'referral_code', '')));
BEGIN
  INSERT INTO public.profiles (id, full_name, first_name, last_name, phone, date_of_birth, address)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data ->> 'full_name',
    NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'first_name', '')), ''),
    NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'last_name', '')), ''),
    NEW.raw_user_meta_data ->> 'phone',
    NULLIF(NEW.raw_user_meta_data ->> 'date_of_birth', '')::date,
    NEW.raw_user_meta_data ->> 'address'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'customer'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  IF v_id ~ '^[A-Z0-9]{6,20}$' OR v_ref ~ '^[A-Z0-9-]{3,32}$' THEN
    INSERT INTO public.member_signup_details (user_id, id_number, referral_code)
    VALUES (NEW.id,
            CASE WHEN v_id ~ '^[A-Z0-9]{6,20}$' THEN v_id END,
            CASE WHEN v_ref ~ '^[A-Z0-9-]{3,32}$' THEN v_ref END)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  IF NEW.raw_user_meta_data ? 'id_number' OR NEW.raw_user_meta_data ? 'referral_code' THEN
    UPDATE auth.users
    SET raw_user_meta_data = raw_user_meta_data - 'id_number' - 'referral_code'
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;
