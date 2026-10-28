-- 29 Oct 2026: the Cannaplug loyalty rewards program and the referral program, built to work together.
--   Earning: 1 point for every R50 spent (was R10). Existing points are converted once at the old rate (balance and
--   lifetime points divided by 5, rounded down, written to the ledger as 'points_conversion') and the tier
--   thresholds are scaled the same way.
--   Rewards: 5 points = 1 free Greenhouse pre-roll or bud, 10 points = 1 free Entry Indoor pre-roll or bud. Redeemed at
--   the till: the cashier attaches the member and marks one unit free; the points are deducted in the same sale
--   (pos_complete_sale), given back if the sale is voided. Online redemption is "coming soon": redeem_loyalty_points
--   (the old points-for-rand-discount) now refuses.
--   Usernames: profiles.username (unique, 3-20 of a-z 0-9 _), required at sign-up, set once from the portal for existing
--   members. A verified member's (or staff member's) username is their referral code and link.
--   Referrals: a new member who enters a referral code at sign-up is recorded as a pending referral. When that friend
--   has spent R50 (paid online orders and till sales together) the referrer earns 1 point, once per friend.
--   Needs 20261029005000_loyalty_sources (new ledger source types). No DROP and no DELETE in this file.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Rates, tiers and the one-off conversion of existing points
-- ---------------------------------------------------------------------------------------------------------------
UPDATE public.loyalty_tiers SET
  min_lifetime_points = CASE code WHEN 'sprout' THEN 100 WHEN 'bloom' THEN 400 WHEN 'canopy' THEN 1000 ELSE min_lifetime_points END,
  perks = CASE code
    WHEN 'seed' THEN ARRAY['Earn 1 point per R50 spent', 'Free Greenhouse pre-roll or bud at 5 points']
    ELSE perks END;

DO $$
DECLARE
  r record;
  v_new integer;
  v_delta integer;
  v_life integer;
  v_tier uuid;
BEGIN
  -- Only while the old rate (R10 per point) is still in force, so a re-run never converts twice.
  IF (SELECT value FROM public.loyalty_rules WHERE code = 'earn_rand_per_point') = 50 THEN RETURN; END IF;
  FOR r IN SELECT user_id, points_balance, lifetime_points FROM public.loyalty_accounts ORDER BY user_id LOOP
    v_new := CASE WHEN r.points_balance > 0 THEN floor(r.points_balance / 5.0)::integer ELSE r.points_balance END;
    v_delta := v_new - r.points_balance;
    IF v_delta <> 0 THEN
      INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, points, balance_after)
      VALUES (r.user_id, 'reversal', 'points_conversion', r.user_id, v_delta, 0);
    END IF;
    v_life := floor(r.lifetime_points / 5.0)::integer;
    SELECT t.id INTO v_tier FROM public.loyalty_tiers t
    WHERE t.is_active AND t.min_lifetime_points <= v_life ORDER BY t.min_lifetime_points DESC LIMIT 1;
    PERFORM set_config('cannaplug.loyalty_write', 'on', true);
    UPDATE public.loyalty_accounts SET lifetime_points = v_life, tier_id = v_tier, updated_at = now()
    WHERE user_id = r.user_id;
    PERFORM set_config('cannaplug.loyalty_write', 'off', true);
  END LOOP;
END $$;

UPDATE public.loyalty_rules SET value = 50, updated_at = now() WHERE code = 'earn_rand_per_point';

-- Referral rewards count toward the tier like any other earning.
CREATE OR REPLACE FUNCTION public._loyalty_apply_txn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account public.loyalty_accounts;
  v_balance integer;
  v_lifetime integer;
  v_tier uuid;
BEGIN
  PERFORM set_config('cannaplug.loyalty_write', 'on', true);
  INSERT INTO public.loyalty_accounts (user_id) VALUES (NEW.user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_account FROM public.loyalty_accounts WHERE user_id = NEW.user_id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.loyalty_transactions t
             WHERE t.source_type = NEW.source_type AND t.source_id = NEW.source_id) THEN
    PERFORM set_config('cannaplug.loyalty_write', 'off', true);
    RETURN NULL;
  END IF;

  IF NEW.txn_type = 'redeem' AND v_account.points_balance + NEW.points < 0 THEN
    RAISE EXCEPTION 'insufficient_points: balance is % points', v_account.points_balance;
  END IF;

  v_balance := v_account.points_balance + NEW.points;
  -- Lifetime points (which decide the tier) follow earning and its reversals, never spending.
  v_lifetime := GREATEST(v_account.lifetime_points
    + CASE WHEN NEW.source_type IN ('order', 'order_cancel', 'pos_sale', 'pos_sale_void', 'pos_refund', 'referral')
           THEN NEW.points ELSE 0 END, 0);
  SELECT t.id INTO v_tier FROM public.loyalty_tiers t
  WHERE t.is_active AND t.min_lifetime_points <= v_lifetime
  ORDER BY t.min_lifetime_points DESC LIMIT 1;

  UPDATE public.loyalty_accounts
  SET points_balance = v_balance, lifetime_points = v_lifetime, tier_id = v_tier, updated_at = now()
  WHERE user_id = NEW.user_id;
  PERFORM set_config('cannaplug.loyalty_write', 'off', true);

  NEW.balance_after := v_balance;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Usernames
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_username_format') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_username_format
      CHECK (username IS NULL OR username ~ '^[a-z0-9_]{3,20}$');
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_uidx ON public.profiles (username) WHERE username IS NOT NULL;

CREATE OR REPLACE FUNCTION public._username_reserved(p_username text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT lower(COALESCE(p_username, '')) IN (
  'admin', 'administrator', 'root', 'support', 'staff', 'team', 'help', 'info', 'owner', 'official', 'moderator',
  'manager', 'budtender', 'system', 'null', 'undefined', 'cannaplug', 'cannaplug012', 'canna_plug', 'api', 'www',
  'shop', 'store', 'journal', 'account', 'checkout', 'rewards', 'referral', 'login', 'signup', 'billing', 'security') $$;

-- 'ok' | 'invalid' | 'reserved' | 'taken'
CREATE OR REPLACE FUNCTION public.username_check(p_username text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v text := lower(btrim(COALESCE(p_username, '')));
BEGIN
  IF v !~ '^[a-z0-9_]{3,20}$' THEN RETURN 'invalid'; END IF;
  IF public._username_reserved(v) THEN RETURN 'reserved'; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.username = v) THEN RETURN 'taken'; END IF;
  RETURN 'ok';
END;
$$;

-- A member adds their username once. It is also their referral code, so it cannot be changed afterwards.
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

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Referrals
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.referral_points() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 1 $$;
CREATE OR REPLACE FUNCTION public.referral_min_spend() RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 50::numeric $$;

-- Verified members (and staff) have an active referral code; their username is the code.
CREATE OR REPLACE FUNCTION public._referral_eligible(p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT public._is_staff(p_user) OR EXISTS (
  SELECT 1 FROM public.customer_verification cv
  WHERE cv.user_id = p_user AND cv.status = 'verified'
    AND (cv.document_expires_on IS NULL OR cv.document_expires_on >= current_date)) $$;

CREATE TABLE IF NOT EXISTS public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referee_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  code text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'qualified')),
  created_at timestamptz NOT NULL DEFAULT now(),
  qualified_at timestamptz,
  spend_rand numeric(10,2),
  CONSTRAINT referrals_not_self CHECK (referrer_id <> referee_id)
);
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON public.referrals (referrer_id, created_at DESC);
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.referrals FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.referrals TO service_role;

-- Is this a code someone can use at sign-up? (Read-only; the answer says nothing about who the member is.)
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

-- Called after a friend's points are accrued. Once the friend has spent R50 the referrer earns the point (once).
CREATE OR REPLACE FUNCTION public._referral_check(p_referee uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ref public.referrals;
  v_spend numeric(10,2);
BEGIN
  IF p_referee IS NULL THEN RETURN; END IF;
  SELECT * INTO v_ref FROM public.referrals WHERE referee_id = p_referee AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE((SELECT sum(s.total) FROM public.pos_sales s
                   WHERE s.customer_id = p_referee AND s.status IN ('completed', 'partially_refunded')), 0)
       + COALESCE((SELECT sum(o.total_rand - o.delivery_fee_rand) FROM public.orders o
                   WHERE o.user_id = p_referee AND o.status = 'completed'), 0)
  INTO v_spend;
  IF v_spend < public.referral_min_spend() THEN RETURN; END IF;
  UPDATE public.referrals SET status = 'qualified', qualified_at = now(), spend_rand = v_spend WHERE id = v_ref.id;
  INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, points, balance_after)
  VALUES (v_ref.referrer_id, 'earn', 'referral', v_ref.id, public.referral_points(), 0);
  PERFORM public._audit(v_ref.referrer_id, 'referral_qualified', 'referral', v_ref.id,
    jsonb_build_object('points', public.referral_points(), 'friend_spend', v_spend));
END;
$$;

-- Sign-up records the username and any referral code.
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

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Rewards catalogue
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.loyalty_rewards (
  code text PRIMARY KEY CHECK (code ~ '^[a-z_]{3,40}$'),
  name text NOT NULL,
  description text NOT NULL,
  points_cost integer NOT NULL CHECK (points_cost > 0),
  categories text[] NOT NULL,
  -- The grade in brackets at the end of a product's name, e.g. "Orange Road Stick (Greenhouse)".
  grade text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);
ALTER TABLE public.loyalty_rewards ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'loyalty_rewards' AND policyname = 'rewards readable') THEN
    CREATE POLICY "rewards readable" ON public.loyalty_rewards FOR SELECT TO authenticated USING (is_active);
  END IF;
END $$;
REVOKE ALL ON public.loyalty_rewards FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.loyalty_rewards TO authenticated;
GRANT ALL ON public.loyalty_rewards TO service_role;
INSERT INTO public.loyalty_rewards (code, name, description, points_cost, categories, grade, sort_order) VALUES
  ('greenhouse_free', 'Free Greenhouse pre-roll or bud', '1 free Greenhouse pre-roll, or 1 g of Greenhouse bud', 5, ARRAY['Pre-rolls', 'Flower'], 'Greenhouse', 1),
  ('indoor_free', 'Free Indoor pre-roll or bud', '1 free Entry Indoor pre-roll, or 1 g of Entry Indoor bud', 10, ARRAY['Pre-rolls', 'Flower'], 'Entry Indoor', 2)
ON CONFLICT (code) DO NOTHING;

CREATE OR REPLACE FUNCTION public._reward_eligible(p_reward text, p_product uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS (
  SELECT 1 FROM public.loyalty_rewards r JOIN public.products p ON p.id = p_product
  WHERE r.code = p_reward AND r.is_active AND p.is_active AND p.category = ANY (r.categories)
    AND lower(substring(p.name from '\(([^)]*)\)\s*$')) = lower(r.grade)) $$;

-- What a member has and can claim, for the till (staff) -- read-only.
CREATE OR REPLACE FUNCTION public.pos_customer_rewards(p_actor uuid, p_customer uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_points integer;
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  SELECT COALESCE((SELECT a.points_balance FROM public.loyalty_accounts a WHERE a.user_id = p_customer), 0) INTO v_points;
  RETURN jsonb_build_object('points', v_points, 'rewards', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('code', r.code, 'name', r.name, 'points_cost', r.points_cost, 'grade', r.grade,
                                        'categories', r.categories) ORDER BY r.sort_order)
    FROM public.loyalty_rewards r WHERE r.is_active), '[]'::jsonb));
END;
$$;

-- A member's rewards page: username, referral code state and results, and the rewards on offer.
CREATE OR REPLACE FUNCTION public.member_rewards_summary(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_username text;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT p.username INTO v_username FROM public.profiles p WHERE p.id = p_user_id;
  RETURN jsonb_build_object(
    'username', v_username,
    'can_refer', v_username IS NOT NULL AND public._referral_eligible(p_user_id),
    'referral_points', public.referral_points(),
    'referral_min_spend', public.referral_min_spend(),
    'referred', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', COALESCE(NULLIF(btrim(COALESCE(f.first_name, '') || ' ' || COALESCE(left(f.last_name, 1) || '.', '')), ''), 'A friend'),
        'status', r.status, 'joined_at', r.created_at, 'qualified_at', r.qualified_at) ORDER BY r.created_at DESC)
      FROM public.referrals r LEFT JOIN public.profiles f ON f.id = r.referee_id
      WHERE r.referrer_id = p_user_id), '[]'::jsonb),
    'points_from_referrals', COALESCE((SELECT sum(t.points) FROM public.loyalty_transactions t
                                       WHERE t.user_id = p_user_id AND t.source_type = 'referral'), 0),
    'rewards', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', r.code, 'name', r.name,
                                                             'description', r.description, 'points_cost', r.points_cost)
                                          ORDER BY r.sort_order)
                         FROM public.loyalty_rewards r WHERE r.is_active), '[]'::jsonb));
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Points and the till
-- ---------------------------------------------------------------------------------------------------------------
-- Online redemption of points for a rand discount is replaced by rewards (till today, online coming soon).
CREATE OR REPLACE FUNCTION public.redeem_loyalty_points(
  p_user_id uuid, p_order_id uuid, p_points integer, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'redemption_unavailable: online redemption of points is coming soon; points are redeemed for free rewards at the till';
END;
$$;

-- Points are also earned toward a referral once a friend has spent R50.
CREATE OR REPLACE FUNCTION public.accrue_pos_loyalty(p_sale_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sale public.pos_sales;
  v_net numeric(10,2);
  v_points integer;
BEGIN
  PERFORM public._require_read_committed();
  SELECT * INTO v_sale FROM public.pos_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('accrued', false, 'reason', 'sale_not_found'); END IF;
  IF v_sale.customer_id IS NULL THEN RETURN jsonb_build_object('accrued', false, 'reason', 'no_customer'); END IF;
  IF v_sale.status = 'voided' THEN RETURN jsonb_build_object('accrued', false, 'reason', 'voided'); END IF;
  SELECT v_sale.total - COALESCE(SUM(r.amount), 0) INTO v_net FROM public.pos_refunds r WHERE r.sale_id = p_sale_id;
  v_points := public._loyalty_points_for_amount(v_net);
  PERFORM public._referral_check(v_sale.customer_id);
  IF v_points <= 0 THEN RETURN jsonb_build_object('accrued', false, 'reason', 'no_points'); END IF;
  INSERT INTO public.loyalty_ledger (user_id, sale_id, source_type, source_id, points)
  VALUES (v_sale.customer_id, p_sale_id, 'pos_sale', p_sale_id, v_points)
  ON CONFLICT (source_type, source_id) DO NOTHING;
  IF FOUND THEN
    RETURN jsonb_build_object('accrued', true, 'points', v_points);
  END IF;
  RETURN jsonb_build_object('accrued', false, 'reason', 'already_accrued');
END;
$$;

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
  -- Points are earned on what was actually paid for goods: after any redeemed points, and
  -- excluding the delivery fee.
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

-- A voided sale gives back the points spent on a reward in it.
CREATE OR REPLACE FUNCTION public.pos_void_sale(p_actor uuid, p_sale_id uuid, p_reason text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_sale public.pos_sales;
  v_session public.pos_sessions;
  v_batches uuid[];
  v_mv record;
  v_current integer;
  v_response jsonb;
  v_reward_back integer := 0;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('pos_void', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_sale_id, 'r', p_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'reason_required: a reason of 3-500 characters is mandatory';
  END IF;

  SELECT * INTO v_sale FROM public.pos_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sale_not_found'; END IF;
  IF v_sale.status <> 'completed' THEN
    RAISE EXCEPTION 'invalid_sale_state: only completed, unrefunded sales can be voided (%)', v_sale.status;
  END IF;
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = v_sale.session_id FOR SHARE;
  IF v_session.status <> 'open' THEN
    RAISE EXCEPTION 'session_closed: the sale''s till session is closed; issue a refund instead';
  END IF;

  SELECT array_agg(DISTINCT l.batch_id) INTO v_batches
  FROM public.inventory_ledger l
  JOIN public.pos_sale_items i ON i.id = l.reference_id AND l.reference_type = 'pos_sale_item'
  WHERE i.sale_id = p_sale_id AND l.movement_type = 'pos_sale';
  PERFORM public._lock_batches(v_batches);

  FOR v_mv IN
    SELECT l.batch_id, l.product_id, -l.quantity_delta AS qty, l.reference_id
    FROM public.inventory_ledger l
    JOIN public.pos_sale_items i ON i.id = l.reference_id AND l.reference_type = 'pos_sale_item'
    WHERE i.sale_id = p_sale_id AND l.movement_type = 'pos_sale'
    ORDER BY l.product_id, l.batch_id, l.id
  LOOP
    INSERT INTO public.inventory_ledger
      (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
    VALUES
      (v_mv.batch_id, v_mv.product_id, v_mv.qty, 'POS void ' || v_sale.receipt_number,
       'pos_sale_item', v_mv.reference_id, p_actor, 'pos_void_restock');
  END LOOP;

  UPDATE public.pos_sales
  SET status = 'voided', voided_at = now(), voided_by = p_actor, void_reason = btrim(p_reason)
  WHERE id = p_sale_id;

  -- No TOCTOU here: this transaction holds the pos_sales row FOR UPDATE and accrue_pos_loyalty must
  -- take the same lock first, so accrual cannot interleave between this read and the insert below.
  SELECT COALESCE(SUM(points), 0) INTO v_current FROM public.loyalty_ledger WHERE sale_id = p_sale_id;
  IF v_current > 0 THEN
    INSERT INTO public.loyalty_ledger (user_id, sale_id, source_type, source_id, points)
    VALUES (v_sale.customer_id, p_sale_id, 'pos_sale_void', p_sale_id, -v_current)
    ON CONFLICT (source_type, source_id) DO NOTHING;
  END IF;

  -- Points spent on a reward in this sale go back to the member.
  SELECT COALESCE(-SUM(t.points), 0) INTO v_reward_back
  FROM public.loyalty_transactions t WHERE t.source_type = 'pos_reward' AND t.source_id = p_sale_id;
  IF v_reward_back > 0 THEN
    INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, pos_sale_id, points, balance_after)
    VALUES (v_sale.customer_id, 'reversal', 'pos_reward_void', p_sale_id, p_sale_id, v_reward_back, 0)
    ON CONFLICT (source_type, source_id) DO NOTHING;
  END IF;

  PERFORM public._audit(p_actor, 'pos_sale_voided', 'pos_sale', p_sale_id,
    jsonb_build_object('receipt', v_sale.receipt_number, 'total', v_sale.total, 'reason', btrim(p_reason),
                       'session_id', v_sale.session_id, 'loyalty_reversed', v_current,
                       'reward_points_restored', v_reward_back));
  v_response := jsonb_build_object('sale_id', p_sale_id, 'status', 'voided', 'loyalty_reversed', v_current,
                                'reward_points_restored', v_reward_back);
  RETURN public._idem_finish('pos_void', p_actor, p_idempotency_key, v_response);
END;
$$;

-- Till sale with loyalty rewards (free reward items, paid for in points).
CREATE OR REPLACE FUNCTION public.pos_complete_sale(
  p_actor uuid,
  p_session_id uuid,
  p_items jsonb,
  p_tenders jsonb,
  p_customer_id uuid,
  p_idempotency_key text,
  p_order_discount jsonb DEFAULT NULL,
  p_discount_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_role public.app_role;
  v_session public.pos_sessions;
  v_line record;
  v_tender record;
  v_priced jsonb := '[]'::jsonb;
  v_name text;
  v_price numeric(10,2);
  v_total numeric(10,2) := 0;
  v_gross_c bigint := 0;
  v_line_disc_c bigint := 0;
  v_net_c bigint := 0;
  v_order_disc_c bigint := 0;
  v_oalloc jsonb;
  v_discounts jsonb;
  v_unit_c bigint;
  v_gross_line_c bigint;
  v_ld_c bigint;
  v_reason text := NULLIF(btrim(COALESCE(p_discount_reason, '')), '');
  v_tender_sum numeric(10,2) := 0;
  v_sale_id uuid := gen_random_uuid();
  v_receipt text;
  v_item_id uuid;
  v_alloc record;
  v_response jsonb;
  v_staff boolean := false;
  v_manual_c bigint := 0;
  v_staff_c bigint := 0;
  v_reward_c bigint := 0;
  v_reward_pts integer := 0;
  v_rw_cost integer;
  v_rw_name text;
  v_manual_line_c bigint := 0;
BEGIN
  PERFORM public._require_read_committed();
  v_role := public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('pos_sale', p_actor, p_idempotency_key,
    jsonb_build_object('session', p_session_id, 'items', p_items, 'tenders', p_tenders, 'customer', p_customer_id,
                       'od', p_order_discount, 'dr', p_discount_reason));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  -- Structural validation. Only product_id + quantity are read from items: client prices are ignored.
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) e
       WHERE jsonb_typeof(e) <> 'object'
          OR (e->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR (e->>'quantity') !~ '^[1-9][0-9]{0,3}$'
          OR ((e ? 'reward') AND (e->>'reward') !~ '^[a-z_]{3,40}$')) THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;
  IF p_tenders IS NULL OR jsonb_typeof(p_tenders) <> 'array' OR jsonb_array_length(p_tenders) NOT BETWEEN 0 AND 8
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_tenders) t
       WHERE jsonb_typeof(t) <> 'object'
          OR (t->>'method') NOT IN ('cash', 'card', 'eft', 'paypal')
          OR (t->>'amount') !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$'
          OR (t->>'amount')::numeric <= 0
          OR ((t->>'method') = 'cash' AND (t->>'reference') IS NOT NULL)
          OR ((t->>'method') <> 'cash' AND length(COALESCE(t->>'reference', '')) NOT BETWEEN 4 AND 100)) THEN
    RAISE EXCEPTION 'invalid_tenders: method cash|card|eft|paypal, amount > 0 (max 2 decimals), non-cash needs a 4-100 char reference';
  END IF;

  -- Session: shared lock so a concurrent till close waits for this sale (and vice versa).
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = p_session_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'session_closed'; END IF;
  IF v_session.opened_by <> p_actor AND public.role_level(v_role) < public.role_level('manager') THEN
    RAISE EXCEPTION 'session_not_yours';
  END IF;
  IF p_customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_customer_id) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;
  -- Who may be attached as a staff customer (and so get the staff rate): see _pos_can_attach_staff.
  IF p_customer_id IS NOT NULL AND public._is_staff(p_customer_id)
     AND NOT public._pos_can_attach_staff(p_actor, p_customer_id) THEN
    RAISE EXCEPTION 'staff_attach_not_allowed: managers and admins can attach any staff member; a budtender can attach other budtenders, but not themselves';
  END IF;

  -- Price every line from the database. FOR SHARE pins the price for the life of this transaction.
  FOR v_line IN
    SELECT (e->>'product_id')::uuid AS product_id, SUM((e->>'quantity')::integer)::integer AS quantity,
           COALESCE(jsonb_agg(DISTINCT e->'discount') FILTER (WHERE jsonb_typeof(e->'discount') = 'object'), '[]'::jsonb) AS discounts,
           max(e->>'reward') AS reward
    FROM jsonb_array_elements(p_items) e
    GROUP BY 1
    ORDER BY 1
  LOOP
    -- An online-only sale is not offered at the till: the till charges the regular price.
    SELECT p.name,
           CASE WHEN p.sale_online_only AND p.regular_price_rand IS NOT NULL THEN p.regular_price_rand ELSE p.price_rand END
    INTO v_name, v_price
    FROM public.products p WHERE p.id = v_line.product_id AND p.is_active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'product_unavailable: %', v_line.product_id; END IF;
    IF jsonb_array_length(v_line.discounts) > 1 THEN
      RAISE EXCEPTION 'invalid_discount: one product cannot carry two different discounts';
    END IF;
    v_unit_c := round(v_price * 100)::bigint;
    v_gross_line_c := v_unit_c * v_line.quantity;
    v_ld_c := public._pos_discount_cents(v_line.discounts->0, v_gross_line_c);
    -- Loyalty reward: one unit of an eligible product is free, paid for in points (deducted below, in this sale).
    IF v_line.reward IS NOT NULL THEN
      IF p_customer_id IS NULL THEN
        RAISE EXCEPTION 'reward_needs_member: attach the member to use a reward';
      END IF;
      IF jsonb_array_length(v_line.discounts) > 0 THEN
        RAISE EXCEPTION 'invalid_discount: a free reward item cannot also carry a discount';
      END IF;
      SELECT r.points_cost, r.name INTO v_rw_cost, v_rw_name
      FROM public.loyalty_rewards r WHERE r.code = v_line.reward AND r.is_active;
      IF NOT FOUND THEN RAISE EXCEPTION 'reward_unavailable: that reward is not available'; END IF;
      IF NOT public._reward_eligible(v_line.reward, v_line.product_id) THEN
        RAISE EXCEPTION 'reward_not_eligible: % is not covered by that reward', v_name;
      END IF;
      v_ld_c := v_unit_c;
      v_reward_c := v_reward_c + v_ld_c;
      v_reward_pts := v_reward_pts + v_rw_cost;
    END IF;
    v_gross_c := v_gross_c + v_gross_line_c;
    v_line_disc_c := v_line_disc_c + v_ld_c;
    v_priced := v_priced || jsonb_build_array(jsonb_build_object(
      'product_id', v_line.product_id, 'name', v_name, 'unit_price', v_price,
      'quantity', v_line.quantity, 'item_id', gen_random_uuid(),
      'line_discount_c', v_ld_c, 'net_c', v_gross_line_c - v_ld_c));
  END LOOP;

  -- Order discount: taken off what is left after the line discounts, then shared across the lines
  -- (largest remainder, to the cent) so that every line still knows what was really paid for it.
  v_net_c := v_gross_c - v_line_disc_c;
  v_manual_line_c := v_line_disc_c - v_reward_c;
  v_order_disc_c := public._pos_discount_cents(p_order_discount, v_net_c);
  v_manual_c := v_order_disc_c;
  -- Staff rate: when the customer on the sale is a staff member (budtender, manager or admin), the staff percentage
  -- comes off automatically, worked out here from the database. It is not added to a manual order discount: the
  -- larger of the two applies. Nothing about it comes from the browser except which customer was attached.
  v_staff := p_customer_id IS NOT NULL AND public._is_staff(p_customer_id);
  IF v_staff THEN
    v_staff_c := round(v_net_c * public.staff_purchase_percent() / 100)::bigint;
    v_order_disc_c := GREATEST(v_manual_c, v_staff_c);
  END IF;
  -- A reward and the staff rate need no typed reason; anything typed still does.
  IF v_reason IS NULL AND v_manual_line_c = 0 AND v_manual_c = 0 AND (v_reward_c > 0 OR v_staff_c > 0) THEN
    v_reason := concat_ws(' · ',
      CASE WHEN v_reward_c > 0 THEN 'Loyalty reward' END,
      CASE WHEN v_staff_c > 0 THEN 'Staff purchase (' || regexp_replace(public.staff_purchase_percent()::text, '\.0+$', '') || '% off)' END);
  END IF;
  IF v_line_disc_c + v_order_disc_c > 0 THEN
    IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 3 AND 200 THEN
      RAISE EXCEPTION 'discount_reason_required: give a reason of 3-200 characters for the discount';
    END IF;
    -- Any role may discount by any percentage up to 100% (owner decision, 28 Oct 2026), with no approval. Every
    -- discount still needs a reason and is audited. A 100% discount makes a R0 sale: it has no tenders.
  END IF;
  SELECT COALESCE(jsonb_object_agg(r.product_id::text, r.alloc), '{}'::jsonb) INTO v_oalloc
  FROM (
    SELECT q.product_id,
           q.floor_c + CASE WHEN q.rn <= (v_order_disc_c - SUM(q.floor_c) OVER ()) THEN 1 ELSE 0 END AS alloc
    FROM (
      SELECT x.product_id,
             COALESCE(floor(v_order_disc_c * x.net_c::numeric / NULLIF(v_net_c, 0)), 0)::bigint AS floor_c,
             row_number() OVER (ORDER BY COALESCE((v_order_disc_c * x.net_c::numeric / NULLIF(v_net_c, 0))
                                         - floor(v_order_disc_c * x.net_c::numeric / NULLIF(v_net_c, 0)), 0) DESC, x.product_id) AS rn
      FROM jsonb_to_recordset(v_priced) AS x(product_id uuid, net_c bigint)
    ) q
  ) r;
  v_total := (v_net_c - v_order_disc_c)::numeric / 100;

  -- Server-side tender validation: sum(tenders) must equal the server-computed total exactly.
  SELECT COALESCE(SUM((t->>'amount')::numeric), 0) INTO v_tender_sum FROM jsonb_array_elements(p_tenders) t;
  IF v_tender_sum <> v_total THEN
    RAISE EXCEPTION 'tender_mismatch: tendered % but sale total is %', v_tender_sum, v_total;
  END IF;

  -- Serialise use of external payment references (also against webhook-confirmed orders).
  FOR v_tender IN
    SELECT DISTINCT (t->>'method') AS method, (t->>'reference') AS reference
    FROM jsonb_array_elements(p_tenders) t WHERE (t->>'reference') IS NOT NULL
    ORDER BY 2, 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('payref:' || v_tender.method || ':' || v_tender.reference, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('payref:' || v_tender.reference, 1));
    IF EXISTS (SELECT 1 FROM public.pos_tenders x WHERE x.method = v_tender.method AND x.reference = v_tender.reference)
       OR EXISTS (SELECT 1 FROM public.payment_events pe WHERE pe.provider = v_tender.method AND pe.provider_event_id = v_tender.reference) THEN
      RAISE EXCEPTION 'payment_reference_in_use: % reference % was already recorded', v_tender.method, v_tender.reference;
    END IF;
  END LOOP;

  v_receipt := 'POS-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('public.pos_receipt_seq')::text, 6, '0');
  INSERT INTO public.pos_sales (id, receipt_number, session_id, cashier_id, customer_id, subtotal, discount_rand,
                                discount_reason, total, idempotency_key, staff_purchase, staff_discount_rand)
  VALUES (v_sale_id, v_receipt, p_session_id, p_actor, p_customer_id, v_gross_c::numeric / 100,
          (v_line_disc_c + v_order_disc_c)::numeric / 100,
          CASE WHEN v_line_disc_c + v_order_disc_c > 0 THEN v_reason END, v_total,
          p_actor::text || ':' || p_idempotency_key, v_staff, v_staff_c::numeric / 100);

  FOR v_tender IN SELECT (t->>'method') AS method, (t->>'amount')::numeric(10,2) AS amount, (t->>'reference') AS reference
                  FROM jsonb_array_elements(p_tenders) t LOOP
    INSERT INTO public.pos_tenders (sale_id, method, amount, reference)
    VALUES (v_sale_id, v_tender.method, v_tender.amount, v_tender.reference);
  END LOOP;

  FOR v_line IN
    SELECT x.product_id, x.name, x.unit_price, x.quantity, x.item_id, x.line_discount_c,
           COALESCE((v_oalloc->>(x.product_id::text))::bigint, 0) AS order_discount_c
    FROM jsonb_to_recordset(v_priced) AS x(product_id uuid, name text, unit_price numeric, quantity integer, item_id uuid, line_discount_c bigint)
    ORDER BY x.product_id
  LOOP
    INSERT INTO public.pos_sale_items (id, sale_id, product_id, product_name, unit_price_rand, quantity,
                                       line_discount_rand, order_discount_rand, line_total)
    VALUES (v_line.item_id, v_sale_id, v_line.product_id, v_line.name, v_line.unit_price, v_line.quantity,
            v_line.line_discount_c::numeric / 100, v_line.order_discount_c::numeric / 100,
            v_line.unit_price * v_line.quantity - (v_line.line_discount_c + v_line.order_discount_c)::numeric / 100);

    PERFORM public._expire_holds(v_line.product_id);
    FOR v_alloc IN SELECT * FROM public._allocate_fefo(v_line.product_id, v_line.quantity) LOOP
      INSERT INTO public.inventory_ledger
        (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
      VALUES
        (v_alloc.o_batch_id, v_line.product_id, -v_alloc.o_quantity, 'POS sale ' || v_receipt,
         'pos_sale_item', v_line.item_id, p_actor, 'pos_sale');
    END LOOP;
  END LOOP;

  IF v_reward_pts > 0 THEN
    -- Points spent on the reward(s): refused (insufficient_points) if the member does not have enough.
    INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, pos_sale_id, points, balance_after)
    VALUES (p_customer_id, 'redeem', 'pos_reward', v_sale_id, v_sale_id, -v_reward_pts, 0);
  END IF;

  IF v_line_disc_c + v_order_disc_c > 0 THEN
    PERFORM public._audit(p_actor, 'pos_sale_discount', 'pos_sale', v_sale_id, jsonb_build_object(
      'receipt_number', v_receipt, 'gross', v_gross_c::numeric / 100, 'line_discounts', v_line_disc_c::numeric / 100,
      'order_discount', v_order_disc_c::numeric / 100, 'total', v_total, 'reason', v_reason,
      'staff_purchase', v_staff, 'staff_discount', v_staff_c::numeric / 100,
      'reward_points', v_reward_pts, 'reward_value', v_reward_c::numeric / 100));
  END IF;

  v_response := jsonb_build_object(
    'sale_id', v_sale_id, 'receipt_number', v_receipt, 'total', v_total, 'session_id', p_session_id,
    'subtotal', v_gross_c::numeric / 100, 'discount', (v_line_disc_c + v_order_disc_c)::numeric / 100,
    'customer_id', p_customer_id, 'staff_purchase', v_staff, 'staff_discount', v_staff_c::numeric / 100,
    'reward_points', v_reward_pts,
    'items', (SELECT jsonb_agg(jsonb_build_object('product_id', i.product_id, 'name', i.product_name,
                'quantity', i.quantity, 'unit_price', i.unit_price_rand, 'line_discount', i.line_discount_rand,
                'order_discount', i.order_discount_rand, 'line_total', i.line_total) ORDER BY i.product_name)
              FROM public.pos_sale_items i WHERE i.sale_id = v_sale_id),
    'tenders', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', t.method, 'amount', t.amount, 'reference', t.reference) ORDER BY t.created_at, t.id)
                         FROM public.pos_tenders t WHERE t.sale_id = v_sale_id), '[]'::jsonb));
  RETURN public._idem_finish('pos_sale', p_actor, p_idempotency_key, v_response);
END;
$$;
REVOKE ALL ON FUNCTION public.pos_complete_sale(uuid, uuid, jsonb, jsonb, uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_complete_sale(uuid, uuid, jsonb, jsonb, uuid, text, jsonb, text) TO service_role;

-- Till customer search: also by username, and the result carries the username.
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
REVOKE ALL ON FUNCTION public.pos_customer_search(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_customer_search(uuid, text, integer) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Permissions: every function below is for the server (service role) only.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
      '_username_reserved', 'username_check', 'member_set_username', 'referral_points', 'referral_min_spend',
      '_referral_eligible', 'referral_code_check', '_referral_check', 'handle_new_user', '_reward_eligible',
      'pos_customer_rewards', 'member_rewards_summary', 'redeem_loyalty_points', 'accrue_pos_loyalty',
      'accrue_order_loyalty', 'pos_void_sale', 'pos_complete_sale', 'pos_customer_search', '_loyalty_apply_txn'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;
