-- Milestone 4: live member account.
--
--   1. Addresses            server-side ownership: all writes go through service-only RPCs
--   2. Order timeline       customers read their OWN order_status_history (column-limited) + Realtime
--   3. Loyalty              loyalty_accounts / _transactions / _tiers / _rules. The balance is
--                           derived by trigger from an append-only ledger and cannot be written by
--                           any client role. Accrual / redemption / reversal are database
--                           transactions linked to the source order or POS sale.
--   4. Wishlist + back-in-stock subscriptions (RLS, writable by the owner only)
--   5. Reorder              re-validates product, price and stock inside one transaction
--
-- Conventions inherited from Milestone 3: SECURITY DEFINER functions use search_path = '', mutating
-- RPCs are executable by service_role only, and the caller identity is passed in by the server
-- (which takes it from the verified JWT, never from the browser).

-- ---------------------------------------------------------------------------
-- 0. Pre-existing legacy table
-- ---------------------------------------------------------------------------

-- The hosted project predates this repo's migrations and carries an unused, empty
-- `loyalty_transactions` from the original Lovable schema (columns: transaction_type, order_id text,
-- description; nothing references it). Its name and primary-key name collide with the ledger below, so
-- it is moved aside — renamed, never dropped — ONLY when that legacy shape is detected. Fresh
-- databases (and re-runs) do not have the legacy column, so this is a no-op for them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'loyalty_transactions'
               AND column_name = 'transaction_type') THEN
    IF to_regclass('public.loyalty_transactions_legacy') IS NOT NULL THEN
      RAISE EXCEPTION 'loyalty_transactions_legacy already exists; resolve manually before applying';
    END IF;
    ALTER TABLE public.loyalty_transactions RENAME TO loyalty_transactions_legacy;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loyalty_transactions_pkey'
               AND conrelid = 'public.loyalty_transactions_legacy'::regclass) THEN
      ALTER TABLE public.loyalty_transactions_legacy
        RENAME CONSTRAINT loyalty_transactions_pkey TO loyalty_transactions_legacy_pkey;
    END IF;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. Addresses
-- ---------------------------------------------------------------------------

-- Browser clients may read their own addresses (RLS) but can no longer write them directly: the
-- "one default address" rule and the per-user cap must hold atomically, which row-level policies
-- cannot guarantee. All writes go through member_save_address / member_delete_address /
-- member_set_default_address below.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.addresses FROM authenticated;
REVOKE ALL ON public.addresses FROM anon;

CREATE OR REPLACE FUNCTION public.member_save_address(
  p_user_id uuid,
  p_address_id uuid,
  p_data jsonb,
  p_make_default boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.addresses;
  v_existing public.addresses;
  v_count integer;
  v_line1 text := btrim(COALESCE(p_data->>'line1', ''));
  v_label text := COALESCE(NULLIF(btrim(p_data->>'label'), ''), 'Home');
  v_default boolean;
BEGIN
  IF p_user_id IS NULL OR p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_address: address details are required';
  END IF;
  IF length(v_line1) NOT BETWEEN 3 AND 200 THEN
    RAISE EXCEPTION 'invalid_address: street address must be 3-200 characters';
  END IF;
  IF length(v_label) > 40
     OR length(COALESCE(p_data->>'recipient_name', '')) > 160
     OR length(COALESCE(p_data->>'phone', '')) > 40
     OR length(COALESCE(p_data->>'line2', '')) > 200
     OR length(COALESCE(p_data->>'suburb', '')) > 100
     OR length(COALESCE(p_data->>'city', '')) > 100
     OR length(COALESCE(p_data->>'province', '')) > 100
     OR length(COALESCE(p_data->>'postal_code', '')) > 12
     OR length(COALESCE(p_data->>'country', '')) > 100
     OR length(COALESCE(p_data->>'delivery_notes', '')) > 500 THEN
    RAISE EXCEPTION 'invalid_address: a field is too long';
  END IF;

  -- Serialise per member so "exactly one default" and the cap hold under concurrent requests.
  PERFORM pg_advisory_xact_lock(hashtextextended('addresses:' || p_user_id::text, 0));

  IF p_address_id IS NOT NULL THEN
    -- Ownership is part of the lookup: another member's id is indistinguishable from a missing one.
    SELECT * INTO v_existing FROM public.addresses WHERE id = p_address_id AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'address_not_found';
    END IF;
  ELSE
    SELECT COUNT(*) INTO v_count FROM public.addresses WHERE user_id = p_user_id;
    IF v_count >= 10 THEN
      RAISE EXCEPTION 'address_limit: you can save at most 10 addresses';
    END IF;
  END IF;

  v_default := COALESCE(p_make_default, false)
    OR NOT EXISTS (SELECT 1 FROM public.addresses WHERE user_id = p_user_id AND id IS DISTINCT FROM p_address_id AND is_default)
    AND NOT EXISTS (SELECT 1 FROM public.addresses WHERE user_id = p_user_id AND id IS DISTINCT FROM p_address_id);

  IF v_default THEN
    UPDATE public.addresses SET is_default = false, updated_at = now()
    WHERE user_id = p_user_id AND is_default AND id IS DISTINCT FROM p_address_id;
  END IF;

  IF p_address_id IS NULL THEN
    INSERT INTO public.addresses (user_id, label, recipient_name, phone, line1, line2, suburb, city,
                                  province, postal_code, country, delivery_notes, is_default)
    VALUES (p_user_id, v_label, NULLIF(btrim(p_data->>'recipient_name'), ''), NULLIF(btrim(p_data->>'phone'), ''),
            v_line1, NULLIF(btrim(p_data->>'line2'), ''), NULLIF(btrim(p_data->>'suburb'), ''),
            NULLIF(btrim(p_data->>'city'), ''), NULLIF(btrim(p_data->>'province'), ''),
            NULLIF(btrim(p_data->>'postal_code'), ''), COALESCE(NULLIF(btrim(p_data->>'country'), ''), 'South Africa'),
            NULLIF(btrim(p_data->>'delivery_notes'), ''), v_default)
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.addresses SET
      label = v_label,
      recipient_name = NULLIF(btrim(p_data->>'recipient_name'), ''),
      phone = NULLIF(btrim(p_data->>'phone'), ''),
      line1 = v_line1,
      line2 = NULLIF(btrim(p_data->>'line2'), ''),
      suburb = NULLIF(btrim(p_data->>'suburb'), ''),
      city = NULLIF(btrim(p_data->>'city'), ''),
      province = NULLIF(btrim(p_data->>'province'), ''),
      postal_code = NULLIF(btrim(p_data->>'postal_code'), ''),
      country = COALESCE(NULLIF(btrim(p_data->>'country'), ''), 'South Africa'),
      delivery_notes = NULLIF(btrim(p_data->>'delivery_notes'), ''),
      is_default = v_default OR v_existing.is_default,
      updated_at = now()
    WHERE id = p_address_id AND user_id = p_user_id
    RETURNING * INTO v_row;
  END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.member_set_default_address(p_user_id uuid, p_address_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.addresses;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('addresses:' || p_user_id::text, 0));
  PERFORM 1 FROM public.addresses WHERE id = p_address_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'address_not_found';
  END IF;
  UPDATE public.addresses SET is_default = false, updated_at = now()
  WHERE user_id = p_user_id AND is_default AND id <> p_address_id;
  UPDATE public.addresses SET is_default = true, updated_at = now()
  WHERE id = p_address_id AND user_id = p_user_id
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.member_delete_address(p_user_id uuid, p_address_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_was_default boolean;
  v_promoted uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('addresses:' || p_user_id::text, 0));
  DELETE FROM public.addresses WHERE id = p_address_id AND user_id = p_user_id
  RETURNING is_default INTO v_was_default;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'address_not_found';
  END IF;
  IF v_was_default THEN
    UPDATE public.addresses SET is_default = true, updated_at = now()
    WHERE id = (SELECT a.id FROM public.addresses a WHERE a.user_id = p_user_id ORDER BY a.updated_at DESC, a.id LIMIT 1)
    RETURNING id INTO v_promoted;
  END IF;
  RETURN jsonb_build_object('deleted', p_address_id, 'promoted_default', v_promoted);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Order timeline (order_status_history) for the owning customer
-- ---------------------------------------------------------------------------

-- Staff notes and actor ids are internal. Customers therefore get a COLUMN-level grant (no `note`,
-- no `actor_user_id`) plus a row policy scoped to orders they own. Supabase Realtime applies both
-- when it decides whether a subscriber may receive a change. Staff keep reading the full history
-- through the service-role admin functions.
DROP POLICY IF EXISTS "own order status history" ON public.order_status_history;
CREATE POLICY "own order status history"
ON public.order_status_history FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.orders o
  WHERE o.id = order_status_history.order_id AND o.user_id = (SELECT auth.uid())
));

REVOKE SELECT ON public.order_status_history FROM authenticated;
GRANT SELECT (id, order_id, from_status, to_status, created_at) ON public.order_status_history TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Loyalty
-- ---------------------------------------------------------------------------

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS loyalty_points_redeemed integer NOT NULL DEFAULT 0 CHECK (loyalty_points_redeemed >= 0),
  ADD COLUMN IF NOT EXISTS loyalty_discount_rand numeric(10,2) NOT NULL DEFAULT 0 CHECK (loyalty_discount_rand >= 0);

COMMENT ON COLUMN public.orders.total_rand IS
  'Amount payable (item subtotal minus loyalty_discount_rand). Payment confirmation compares against this.';

CREATE TABLE public.loyalty_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]{2,40}$'),
  name text NOT NULL,
  min_lifetime_points integer NOT NULL UNIQUE CHECK (min_lifetime_points >= 0),
  perks text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);

INSERT INTO public.loyalty_tiers (code, name, min_lifetime_points, perks, sort_order) VALUES
  ('seed',   'Seed',   0,    ARRAY['Earn 1 point per R10 spent'], 1),
  ('sprout', 'Sprout', 500,  ARRAY['Member-only product drops'], 2),
  ('bloom',  'Bloom',  2000, ARRAY['Early access to new strains'], 3),
  ('canopy', 'Canopy', 5000, ARRAY['Priority support', 'Early access to new strains'], 4);

CREATE TABLE public.loyalty_rules (
  code text PRIMARY KEY CHECK (code IN (
    'earn_rand_per_point', 'redeem_rand_per_point', 'redeem_min_points', 'redeem_max_pct_of_order')),
  value numeric NOT NULL CHECK (value > 0),
  description text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loyalty_rules_pct_chk CHECK (code <> 'redeem_max_pct_of_order' OR value <= 90)
);

INSERT INTO public.loyalty_rules (code, value, description) VALUES
  ('earn_rand_per_point',     10,   'Rand of paid spend that earns one point'),
  ('redeem_rand_per_point',   0.10, 'Rand discount that one point is worth when redeemed'),
  ('redeem_min_points',       100,  'Smallest redemption allowed on one order'),
  ('redeem_max_pct_of_order', 50,   'Largest share of an order''s item subtotal points may pay for (percent)');

CREATE OR REPLACE FUNCTION public._loyalty_rule(p_code text)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_value numeric;
BEGIN
  SELECT value INTO v_value FROM public.loyalty_rules WHERE code = p_code;
  IF v_value IS NULL THEN
    RAISE EXCEPTION 'loyalty_rule_missing: %', p_code;
  END IF;
  RETURN v_value;
END;
$$;

CREATE OR REPLACE FUNCTION public._loyalty_points_for_amount(p_amount numeric)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT GREATEST(floor(COALESCE(p_amount, 0) / public._loyalty_rule('earn_rand_per_point')), 0)::integer;
$$;

-- The account row is a cache of the ledger: balance and lifetime points are maintained ONLY by the
-- ledger trigger below. The guard makes that authoritative for every role, service_role included.
CREATE TABLE public.loyalty_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  points_balance integer NOT NULL DEFAULT 0,
  lifetime_points integer NOT NULL DEFAULT 0 CHECK (lifetime_points >= 0),
  tier_id uuid REFERENCES public.loyalty_tiers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.loyalty_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  txn_type text NOT NULL CHECK (txn_type IN ('earn', 'redeem', 'reversal')),
  source_type text NOT NULL CHECK (source_type IN (
    'order', 'order_cancel', 'order_redeem', 'order_redeem_release',
    'pos_sale', 'pos_sale_void', 'pos_refund')),
  source_id uuid NOT NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE RESTRICT,
  pos_sale_id uuid REFERENCES public.pos_sales(id) ON DELETE RESTRICT,
  points integer NOT NULL CHECK (points <> 0),
  balance_after integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One ledger row per business event: a retried accrual / redemption can never apply twice.
  CONSTRAINT loyalty_transactions_source_uniq UNIQUE (source_type, source_id),
  CONSTRAINT loyalty_transactions_sign_chk CHECK (
    (txn_type = 'earn' AND points > 0) OR (txn_type = 'redeem' AND points < 0) OR txn_type = 'reversal'),
  -- Every row is traceable to the order or POS sale that caused it.
  CONSTRAINT loyalty_transactions_source_link_chk CHECK (
    (source_type LIKE 'order%' AND order_id = source_id)
    OR (source_type LIKE 'pos\_%' AND pos_sale_id IS NOT NULL))
);
CREATE INDEX loyalty_transactions_user_idx ON public.loyalty_transactions (user_id, created_at DESC);
CREATE INDEX loyalty_transactions_order_idx ON public.loyalty_transactions (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX loyalty_transactions_sale_idx ON public.loyalty_transactions (pos_sale_id) WHERE pos_sale_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public._loyalty_account_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF COALESCE(current_setting('cannaplug.loyalty_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'loyalty_accounts is maintained by the loyalty ledger only';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER loyalty_accounts_ledger_only BEFORE INSERT OR UPDATE OR DELETE ON public.loyalty_accounts
  FOR EACH ROW EXECUTE FUNCTION public._loyalty_account_guard();
CREATE TRIGGER loyalty_transactions_append_only BEFORE UPDATE OR DELETE ON public.loyalty_transactions
  FOR EACH ROW EXECUTE FUNCTION public._append_only_guard();

-- Applies a ledger row to the account. BEFORE INSERT so balance_after is recorded on the row.
-- Order of operations is the idempotency + overspend guarantee:
--   1. lock the member's account row   -> every ledger write for one member is serialised
--   2. look for the same (source_type, source_id) -> a duplicate returns NULL (row skipped, no effect)
--   3. refuse a redemption larger than the balance (reversals may legitimately push it negative:
--      clawing back points earned on a sale that was later voided/refunded)
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
    + CASE WHEN NEW.source_type IN ('order', 'order_cancel', 'pos_sale', 'pos_sale_void', 'pos_refund')
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
CREATE TRIGGER loyalty_transactions_apply BEFORE INSERT ON public.loyalty_transactions
  FOR EACH ROW EXECUTE FUNCTION public._loyalty_apply_txn();

-- Milestone 3 POS code writes loyalty_ledger. It stays as the POS event feed; every row is mirrored
-- into loyalty_transactions in the same transaction, so there is a single balance and a single tier.
CREATE OR REPLACE FUNCTION public._loyalty_ledger_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.loyalty_transactions
    (user_id, txn_type, source_type, source_id, pos_sale_id, points, balance_after, created_at)
  VALUES
    (NEW.user_id, CASE WHEN NEW.points > 0 THEN 'earn' ELSE 'reversal' END, NEW.source_type,
     NEW.source_id, NEW.sale_id, NEW.points, 0, NEW.created_at);
  RETURN NULL;
END;
$$;
CREATE TRIGGER loyalty_ledger_mirror AFTER INSERT ON public.loyalty_ledger
  FOR EACH ROW EXECUTE FUNCTION public._loyalty_ledger_mirror();

-- Carry pre-existing POS points into the new ledger (balance/tier are derived by the trigger).
INSERT INTO public.loyalty_transactions
  (user_id, txn_type, source_type, source_id, pos_sale_id, points, balance_after, created_at)
SELECT l.user_id, CASE WHEN l.points > 0 THEN 'earn' ELSE 'reversal' END, l.source_type, l.source_id,
       l.sale_id, l.points, 0, l.created_at
FROM public.loyalty_ledger l
WHERE l.sale_id IS NOT NULL
ORDER BY l.created_at, l.id;

-- POS accrual now follows loyalty_rules (default 1 point per R10, identical to Milestone 3).
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

-- POS refunds reverse points with the same rule (the only change from Milestone 3 is the target line).
-- @@POS_REFUND_SALE@@

-- Online orders: earn on completion, release/claw back on cancellation. Both run inside the
-- transaction that changes the order status (manual transitions and any future payment flow), and
-- both are idempotent per order.
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
  -- Points are earned on what was actually paid (after any redeemed points).
  v_points := public._loyalty_points_for_amount(v_order.total_rand);
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

CREATE OR REPLACE FUNCTION public.reverse_order_loyalty(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
  v_redeemed integer := 0;
  v_earned integer := 0;
BEGIN
  PERFORM public._require_read_committed();
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.status <> 'cancelled' THEN
    RETURN jsonb_build_object('reversed', false, 'reason', 'not_cancelled');
  END IF;
  SELECT -t.points INTO v_redeemed FROM public.loyalty_transactions t
  WHERE t.source_type = 'order_redeem' AND t.source_id = p_order_id;
  IF COALESCE(v_redeemed, 0) > 0 THEN
    INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, order_id, points)
    VALUES (v_order.user_id, 'reversal', 'order_redeem_release', p_order_id, p_order_id, v_redeemed)
    ON CONFLICT (source_type, source_id) DO NOTHING;
  END IF;
  SELECT t.points INTO v_earned FROM public.loyalty_transactions t
  WHERE t.source_type = 'order' AND t.source_id = p_order_id;
  IF COALESCE(v_earned, 0) > 0 THEN
    INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, order_id, points)
    VALUES (v_order.user_id, 'reversal', 'order_cancel', p_order_id, p_order_id, -v_earned)
    ON CONFLICT (source_type, source_id) DO NOTHING;
  END IF;
  RETURN jsonb_build_object('reversed', true, 'released', COALESCE(v_redeemed, 0), 'clawed_back', COALESCE(v_earned, 0));
END;
$$;

CREATE OR REPLACE FUNCTION public._orders_loyalty_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'completed' THEN
    PERFORM public.accrue_order_loyalty(NEW.id);
  ELSIF NEW.status = 'cancelled' THEN
    PERFORM public.reverse_order_loyalty(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER orders_loyalty_on_status AFTER UPDATE OF status ON public.orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed', 'cancelled'))
  EXECUTE FUNCTION public._orders_loyalty_trigger();

-- Redemption: converts points into a discount on ONE unpaid order owned by the caller.
-- Limits (all enforced here, none by the browser): minimum, balance, share of the item subtotal,
-- one redemption per order, order must still be awaiting payment.
CREATE OR REPLACE FUNCTION public.redeem_loyalty_points(
  p_user_id uuid,
  p_order_id uuid,
  p_points integer,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_order public.orders;
  v_subtotal numeric(10,2);
  v_rate numeric := public._loyalty_rule('redeem_rand_per_point');
  v_min integer := public._loyalty_rule('redeem_min_points')::integer;
  v_pct numeric := public._loyalty_rule('redeem_max_pct_of_order');
  v_max_discount numeric(10,2);
  v_max_points integer;
  v_discount numeric(10,2);
  v_balance integer;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  v_cached := public._idem_begin('loyalty_redeem', p_user_id, p_idempotency_key,
    jsonb_build_object('order', p_order_id, 'points', p_points));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;
  IF p_points IS NULL OR p_points <= 0 THEN
    RAISE EXCEPTION 'invalid_points: enter a whole number of points above zero';
  END IF;

  -- Ownership is part of the lookup: someone else's order is indistinguishable from a missing one.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;
  IF v_order.status <> 'awaiting_payment' THEN
    RAISE EXCEPTION 'order_not_redeemable: points can only be applied to an order that is awaiting payment';
  END IF;
  IF v_order.loyalty_points_redeemed > 0
     OR EXISTS (SELECT 1 FROM public.loyalty_transactions t WHERE t.source_type = 'order_redeem' AND t.source_id = p_order_id) THEN
    RAISE EXCEPTION 'redemption_exists: points were already applied to this order';
  END IF;
  IF p_points < v_min THEN
    RAISE EXCEPTION 'below_minimum: the minimum redemption is % points', v_min;
  END IF;

  SELECT COALESCE(SUM(oi.unit_price_rand * oi.quantity), 0)::numeric(10,2) INTO v_subtotal
  FROM public.order_items oi WHERE oi.order_id = p_order_id;
  v_max_discount := (floor(v_subtotal * v_pct) / 100)::numeric(10,2);
  v_max_points := floor(v_max_discount / v_rate)::integer;
  IF p_points > v_max_points THEN
    RAISE EXCEPTION 'exceeds_order_limit: at most % points can be applied to this order', v_max_points;
  END IF;

  -- The ledger trigger locks the account, re-checks the balance and records balance_after.
  INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, order_id, points)
  VALUES (p_user_id, 'redeem', 'order_redeem', p_order_id, p_order_id, -p_points)
  RETURNING balance_after INTO v_balance;

  v_discount := round(p_points * v_rate, 2);
  UPDATE public.orders
  SET loyalty_points_redeemed = p_points,
      loyalty_discount_rand = v_discount,
      total_rand = v_subtotal - v_discount
  WHERE id = p_order_id;

  PERFORM public._audit(p_user_id, 'loyalty_points_redeemed', 'order', p_order_id,
    jsonb_build_object('points', p_points, 'discount', v_discount, 'balance_after', v_balance));
  v_response := jsonb_build_object('order_id', p_order_id, 'points', p_points, 'discount', v_discount,
    'total', v_subtotal - v_discount, 'balance', v_balance);
  RETURN public._idem_finish('loyalty_redeem', p_user_id, p_idempotency_key, v_response);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Wishlist and back-in-stock subscriptions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._product_available(p_product_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(SUM(b.qty_on_hand - b.qty_held), 0)::integer
  FROM public.inventory_batches b
  WHERE b.product_id = p_product_id AND (b.expires_at IS NULL OR b.expires_at > now());
$$;

CREATE TABLE public.wishlist_items (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE public.back_in_stock_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'notified')),
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  CONSTRAINT back_in_stock_notified_chk CHECK ((status = 'notified') = (notified_at IS NOT NULL))
);
CREATE UNIQUE INDEX back_in_stock_one_active_idx ON public.back_in_stock_subscriptions (user_id, product_id)
  WHERE status = 'active';
CREATE INDEX back_in_stock_active_product_idx ON public.back_in_stock_subscriptions (product_id)
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION public._wishlist_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('wishlist:' || NEW.user_id::text, 0));
  IF (SELECT COUNT(*) FROM public.wishlist_items w WHERE w.user_id = NEW.user_id) >= 200 THEN
    RAISE EXCEPTION 'wishlist_full: you can save at most 200 products';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wishlist_items_guard BEFORE INSERT ON public.wishlist_items
  FOR EACH ROW EXECUTE FUNCTION public._wishlist_guard();

CREATE OR REPLACE FUNCTION public._back_in_stock_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bis:' || NEW.user_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = NEW.product_id AND p.is_active) THEN
    RAISE EXCEPTION 'product_unavailable';
  END IF;
  IF public._product_available(NEW.product_id) > 0 THEN
    RAISE EXCEPTION 'product_in_stock: this product is available now';
  END IF;
  IF (SELECT COUNT(*) FROM public.back_in_stock_subscriptions s
      WHERE s.user_id = NEW.user_id AND s.status = 'active') >= 50 THEN
    RAISE EXCEPTION 'subscription_limit: you can follow at most 50 products';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER back_in_stock_guard BEFORE INSERT ON public.back_in_stock_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public._back_in_stock_guard();

-- Job entry point: atomically flips due subscriptions to 'notified' and returns who to tell.
-- Concurrent runs never hand the same subscription to two senders (SKIP LOCKED).
CREATE OR REPLACE FUNCTION public.claim_back_in_stock_notifications(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  PERFORM public._require_read_committed();
  WITH due AS (
    SELECT s.id
    FROM public.back_in_stock_subscriptions s
    WHERE s.status = 'active' AND public._product_available(s.product_id) > 0
    ORDER BY s.created_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)
    FOR UPDATE SKIP LOCKED
  ), done AS (
    UPDATE public.back_in_stock_subscriptions s
    SET status = 'notified', notified_at = now()
    FROM due WHERE s.id = due.id
    RETURNING s.id, s.user_id, s.product_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'user_id', user_id, 'product_id', product_id)), '[]'::jsonb)
  INTO v_rows FROM done;
  RETURN v_rows;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Reorder
-- ---------------------------------------------------------------------------

-- Read-only. Re-checks every line of one of the caller's orders against TODAY's catalogue.
CREATE OR REPLACE FUNCTION public.reorder_check(p_user_id uuid, p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
  v_lines jsonb;
  v_total numeric(10,2);
  v_orderable boolean;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  WITH grouped AS (
    SELECT oi.product_id, SUM(oi.quantity)::integer AS quantity,
           (array_agg(oi.product_name ORDER BY oi.id))[1] AS product_name,
           (array_agg(oi.unit_price_rand ORDER BY oi.id))[1] AS previous_price
    FROM public.order_items oi WHERE oi.order_id = p_order_id
    GROUP BY oi.product_id
  ), checked AS (
    SELECT g.product_id, g.quantity, COALESCE(p.name, g.product_name) AS name, g.previous_price,
           p.price_rand AS current_price,
           CASE WHEN p.id IS NULL OR NOT p.is_active THEN 0 ELSE public._product_available(p.id) END AS available,
           (p.id IS NOT NULL AND p.is_active) AS is_active
    FROM grouped g LEFT JOIN public.products p ON p.id = g.product_id
  )
  SELECT
    jsonb_agg(jsonb_build_object(
      'product_id', c.product_id, 'name', c.name, 'quantity', c.quantity,
      'previous_price', c.previous_price, 'current_price', c.current_price,
      'available', c.available,
      'status', CASE WHEN NOT c.is_active THEN 'unavailable'
                     WHEN c.available < c.quantity THEN 'insufficient_stock'
                     WHEN c.current_price <> c.previous_price THEN 'price_changed'
                     ELSE 'ok' END) ORDER BY c.name),
    bool_and(c.is_active AND c.available >= c.quantity),
    SUM(c.current_price * c.quantity) FILTER (WHERE c.is_active)
  INTO v_lines, v_orderable, v_total
  FROM checked c;

  RETURN jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number,
    'lines', COALESCE(v_lines, '[]'::jsonb),
    'orderable', COALESCE(v_orderable, false),
    'current_total', CASE WHEN COALESCE(v_orderable, false) THEN v_total ELSE NULL END);
END;
$$;

-- Creates a NEW order from an old one. The caller must echo the total it showed the member
-- (p_expected_total from reorder_check); if price or stock moved since, nothing is created.
-- Validation, order creation and the stock hold share one transaction, so a product that sells out
-- in between still fails here with insufficient_stock instead of creating a doomed order.
CREATE OR REPLACE FUNCTION public.create_reorder(
  p_user_id uuid,
  p_source_order_id uuid,
  p_expected_total numeric,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_check jsonb;
  v_source public.orders;
  v_items jsonb;
  v_result jsonb;
  v_bad text;
BEGIN
  PERFORM public._require_read_committed();
  IF p_expected_total IS NULL THEN
    RAISE EXCEPTION 'expected_total_required: confirm the current total before reordering';
  END IF;
  v_cached := public._idem_begin('reorder', p_user_id, p_idempotency_key,
    jsonb_build_object('order', p_source_order_id, 'total', p_expected_total));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  v_check := public.reorder_check(p_user_id, p_source_order_id);
  IF NOT (v_check->>'orderable')::boolean THEN
    SELECT string_agg(l->>'name', ', ') INTO v_bad
    FROM jsonb_array_elements(v_check->'lines') l WHERE l->>'status' IN ('unavailable', 'insufficient_stock');
    RAISE EXCEPTION 'reorder_unavailable: %', COALESCE(v_bad, 'no items');
  END IF;
  IF (v_check->>'current_total')::numeric IS DISTINCT FROM p_expected_total THEN
    RAISE EXCEPTION 'price_changed: the current total is R%', (v_check->>'current_total');
  END IF;

  SELECT * INTO v_source FROM public.orders WHERE id = p_source_order_id AND user_id = p_user_id;
  SELECT jsonb_agg(jsonb_build_object('product_id', l->>'product_id', 'quantity', (l->>'quantity')::integer))
  INTO v_items FROM jsonb_array_elements(v_check->'lines') l;

  v_result := public.create_online_order(
    p_user_id, v_items, v_source.contact_name, v_source.contact_phone,
    'Reorder of ' || v_source.order_number, 'ro-' || md5(p_idempotency_key), 30);
  v_result := v_result || jsonb_build_object('source_order_id', p_source_order_id);
  RETURN public._idem_finish('reorder', p_user_id, p_idempotency_key, v_result);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges, RLS, Realtime
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        'member_save_address', 'member_set_default_address', 'member_delete_address',
        '_loyalty_rule', '_loyalty_points_for_amount', '_loyalty_account_guard', '_loyalty_apply_txn',
        '_loyalty_ledger_mirror', 'accrue_order_loyalty', 'reverse_order_loyalty', '_orders_loyalty_trigger',
        'redeem_loyalty_points', '_product_available', '_wishlist_guard', '_back_in_stock_guard',
        'claim_back_in_stock_notifications', 'reorder_check', 'create_reorder'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END
$$;

ALTER TABLE public.loyalty_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wishlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.back_in_stock_subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.loyalty_tiers, public.loyalty_rules, public.loyalty_accounts, public.loyalty_transactions,
  public.wishlist_items, public.back_in_stock_subscriptions FROM anon, authenticated;
GRANT ALL ON public.loyalty_tiers, public.loyalty_rules, public.loyalty_accounts, public.loyalty_transactions,
  public.wishlist_items, public.back_in_stock_subscriptions TO service_role;

-- Loyalty is read-only to members: no INSERT/UPDATE/DELETE privilege exists for any client role.
GRANT SELECT ON public.loyalty_tiers, public.loyalty_rules, public.loyalty_accounts,
  public.loyalty_transactions TO authenticated;
CREATE POLICY "loyalty tiers readable" ON public.loyalty_tiers FOR SELECT TO authenticated USING (is_active);
CREATE POLICY "loyalty rules readable" ON public.loyalty_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY "own or manager read loyalty account" ON public.loyalty_accounts FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT public.has_at_least_role('manager'::public.app_role)));
CREATE POLICY "own or manager read loyalty transactions" ON public.loyalty_transactions FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT public.has_at_least_role('manager'::public.app_role)));

-- Wishlist and subscriptions: members manage exactly their own rows, directly under RLS.
GRANT SELECT, DELETE ON public.wishlist_items, public.back_in_stock_subscriptions TO authenticated;
GRANT INSERT (user_id, product_id) ON public.wishlist_items, public.back_in_stock_subscriptions TO authenticated;
CREATE POLICY "own wishlist select" ON public.wishlist_items FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY "own wishlist insert" ON public.wishlist_items FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid())
    AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = product_id AND p.is_active));
CREATE POLICY "own wishlist delete" ON public.wishlist_items FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY "own subscriptions select" ON public.back_in_stock_subscriptions FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY "own subscriptions insert" ON public.back_in_stock_subscriptions FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "own subscriptions delete" ON public.back_in_stock_subscriptions FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Realtime: members receive only the rows RLS lets them read (own orders, own timeline, own points).
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['orders', 'order_status_history', 'loyalty_accounts', 'loyalty_transactions'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END
$$;

COMMENT ON TABLE public.loyalty_accounts IS
  'Derived cache of loyalty_transactions. Never writable by clients; maintained by the ledger trigger.';
COMMENT ON TABLE public.loyalty_transactions IS
  'Append-only points ledger. Unique per (source_type, source_id) so accrual/redemption are idempotent.';
