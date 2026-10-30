-- 31 Oct 2026: the Plug Back program. A member who brings back 10 empty pre-roll tubes earns 1 complimentary
-- Greenhouse pre-roll. Staff record the tubes at the till and give the free pre-roll in the admin dashboard (Loyalty tab).
--   plug_back_ledger: append-only count of tubes. +n when staff record returned tubes, -10 when a free pre-roll is
--     given, +10 again if that sale is voided. Its balance is the sum of the rows; there is no second counter to drift.
--   plug_back_redeem: gives the free pre-roll as a normal R0 till sale (pos_complete_sale with a 100% line discount) and
--     takes the tubes off in the same transaction, so the receipt, the stock movement and the tube count always agree.
--   Voiding that sale gives the tubes back (trigger on pos_sales). Nothing here touches loyalty points.
-- Every function is SECURITY DEFINER, search_path = '', has an explicit actor, an idempotency key and an audit row, and can
-- be executed by service_role only. The table has RLS and no browser grants. No DROP and no DELETE in this file.

CREATE TABLE IF NOT EXISTS public.plug_back_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  tubes integer NOT NULL CHECK (tubes <> 0),
  source_type text NOT NULL CHECK (source_type IN ('return', 'redeem', 'redeem_void')),
  source_id uuid NOT NULL,
  sale_id uuid REFERENCES public.pos_sales (id) ON DELETE RESTRICT,
  actor_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_type = 'return' AND tubes > 0) OR (source_type = 'redeem' AND tubes < 0) OR (source_type = 'redeem_void' AND tubes > 0)),
  CHECK (source_type = 'return' OR sale_id IS NOT NULL),
  UNIQUE (source_type, source_id)
);
CREATE INDEX IF NOT EXISTS plug_back_ledger_user_idx ON public.plug_back_ledger (user_id, created_at DESC);
ALTER TABLE public.plug_back_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plug_back_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.plug_back_ledger TO service_role;
COMMENT ON TABLE public.plug_back_ledger IS 'Plug Back: empty pre-roll tubes returned (+) and spent on a free Greenhouse pre-roll (-). Append-only.';

CREATE OR REPLACE FUNCTION public._plug_back_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN RAISE EXCEPTION 'plug_back_ledger is append-only'; END; $$;
DROP TRIGGER IF EXISTS plug_back_ledger_append_only ON public.plug_back_ledger;
CREATE TRIGGER plug_back_ledger_append_only BEFORE UPDATE OR DELETE ON public.plug_back_ledger
  FOR EACH ROW EXECUTE FUNCTION public._plug_back_append_only();

-- The rule, in one place: tubes needed for one free pre-roll.
CREATE OR REPLACE FUNCTION public.plug_back_tubes_per_reward()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 10 $$;

-- The free pre-roll must be a Greenhouse pre-roll that is on sale (same grade rule as the points rewards).
CREATE OR REPLACE FUNCTION public._plug_back_eligible(p_product uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS (
  SELECT 1 FROM public.products p
  WHERE p.id = p_product AND p.is_active AND p.category = 'Pre-rolls'
    AND lower(substring(p.name from '\(([^)]*)\)\s*$')) = 'greenhouse') $$;

CREATE OR REPLACE FUNCTION public._plug_back_balance(p_user uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT COALESCE(SUM(tubes), 0)::integer FROM public.plug_back_ledger WHERE user_id = p_user $$;

-- One lock per member, so two tills cannot spend the same tubes.
CREATE OR REPLACE FUNCTION public._plug_back_lock(p_user uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_advisory_xact_lock(hashtextextended('plugback:' || p_user::text, 0)) $$;

-- What a member has, and what the till can give them (read-only).
CREATE OR REPLACE FUNCTION public.plug_back_summary(p_actor uuid, p_customer uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_bal integer;
  v_per integer := public.plug_back_tubes_per_reward();
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  IF p_customer IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_customer) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;
  v_bal := public._plug_back_balance(p_customer);
  RETURN jsonb_build_object(
    'tubes', v_bal,
    'tubes_per_reward', v_per,
    'rewards_available', v_bal / v_per,
    'tubes_to_next', CASE WHEN v_bal % v_per = 0 AND v_bal > 0 THEN 0 ELSE v_per - (v_bal % v_per) END,
    'lifetime_tubes', COALESCE((SELECT SUM(tubes) FROM public.plug_back_ledger WHERE user_id = p_customer AND source_type = 'return'), 0),
    'rewards_given', COALESCE((SELECT count(*) FROM public.plug_back_ledger l WHERE l.user_id = p_customer AND l.source_type = 'redeem'
                               AND NOT EXISTS (SELECT 1 FROM public.plug_back_ledger v WHERE v.source_type = 'redeem_void' AND v.source_id = l.source_id)), 0),
    'products', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'price_rand', p.price_rand) ORDER BY p.name)
                          FROM public.products p WHERE public._plug_back_eligible(p.id)), '[]'::jsonb),
    'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', h.source_type, 'tubes', h.tubes, 'at', h.created_at) ORDER BY h.created_at DESC)
                         FROM (SELECT * FROM public.plug_back_ledger WHERE user_id = p_customer ORDER BY created_at DESC LIMIT 10) h), '[]'::jsonb));
END;
$$;

-- Staff record tubes a member has brought back.
CREATE OR REPLACE FUNCTION public.plug_back_record_return(p_actor uuid, p_customer uuid, p_tubes integer, p_note text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_id uuid := gen_random_uuid();
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('plug_back_return', p_actor, p_idempotency_key,
    jsonb_build_object('c', p_customer, 't', p_tubes, 'n', v_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_tubes IS NULL OR p_tubes NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_quantity: record between 1 and 100 tubes at a time';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 200 THEN RAISE EXCEPTION 'invalid_input: note is too long'; END IF;
  IF p_customer IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_customer) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;
  PERFORM public._plug_back_lock(p_customer);
  INSERT INTO public.plug_back_ledger (id, user_id, tubes, source_type, source_id, actor_id, note)
  VALUES (v_id, p_customer, p_tubes, 'return', v_id, p_actor, v_note);
  PERFORM public._audit(p_actor, 'plug_back_return', 'plug_back', p_customer,
    jsonb_build_object('tubes', p_tubes, 'balance', public._plug_back_balance(p_customer)));
  v_response := jsonb_build_object('customer_id', p_customer, 'recorded', p_tubes, 'tubes', public._plug_back_balance(p_customer));
  RETURN public._idem_finish('plug_back_return', p_actor, p_idempotency_key, v_response);
END;
$$;

-- Give the free Greenhouse pre-roll: an R0 till sale and the tube deduction, in one transaction.
CREATE OR REPLACE FUNCTION public.plug_back_redeem(p_actor uuid, p_session_id uuid, p_customer uuid, p_product uuid, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_per integer := public.plug_back_tubes_per_reward();
  v_sale jsonb;
  v_sale_id uuid;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('plug_back_redeem', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_session_id, 'c', p_customer, 'p', p_product));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_customer IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_customer) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;
  IF p_product IS NULL OR NOT public._plug_back_eligible(p_product) THEN
    RAISE EXCEPTION 'reward_not_eligible: Plug Back gives one free Greenhouse pre-roll';
  END IF;
  PERFORM public._plug_back_lock(p_customer);
  IF public._plug_back_balance(p_customer) < v_per THEN
    RAISE EXCEPTION 'insufficient_tubes: % tubes are needed for a free pre-roll, the member has %', v_per, public._plug_back_balance(p_customer);
  END IF;

  -- The free pre-roll is a normal till sale, so the receipt, stock, till session and audit trail all exist.
  v_sale := public.pos_complete_sale(
    p_actor, p_session_id,
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'quantity', 1,
                                         'discount', jsonb_build_object('kind', 'percent', 'value', '100'))),
    '[]'::jsonb, p_customer, 'plugback-' || p_idempotency_key, NULL, 'Plug Back reward');
  v_sale_id := (v_sale->>'sale_id')::uuid;

  INSERT INTO public.plug_back_ledger (user_id, tubes, source_type, source_id, sale_id, actor_id)
  VALUES (p_customer, -v_per, 'redeem', v_sale_id, v_sale_id, p_actor);
  PERFORM public._audit(p_actor, 'plug_back_redeemed', 'pos_sale', v_sale_id,
    jsonb_build_object('tubes', v_per, 'customer_id', p_customer, 'product_id', p_product,
                       'balance', public._plug_back_balance(p_customer)));
  v_response := v_sale || jsonb_build_object('tubes_spent', v_per, 'tubes', public._plug_back_balance(p_customer));
  RETURN public._idem_finish('plug_back_redeem', p_actor, p_idempotency_key, v_response);
END;
$$;

-- Voiding the free sale gives the tubes back.
CREATE OR REPLACE FUNCTION public._plug_back_void_restore()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_spent integer;
BEGIN
  IF NEW.status = 'voided' AND OLD.status IS DISTINCT FROM 'voided' THEN
    SELECT COALESCE(-SUM(tubes), 0) INTO v_spent FROM public.plug_back_ledger
    WHERE source_type = 'redeem' AND source_id = NEW.id;
    IF v_spent > 0 THEN
      PERFORM public._plug_back_lock(NEW.customer_id);
      INSERT INTO public.plug_back_ledger (user_id, tubes, source_type, source_id, sale_id, actor_id, note)
      VALUES (NEW.customer_id, v_spent, 'redeem_void', NEW.id, NEW.id, NEW.voided_by, 'Sale voided')
      ON CONFLICT (source_type, source_id) DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS pos_sales_plug_back_void ON public.pos_sales;
CREATE TRIGGER pos_sales_plug_back_void AFTER UPDATE OF status ON public.pos_sales
  FOR EACH ROW EXECUTE FUNCTION public._plug_back_void_restore();

REVOKE ALL ON FUNCTION public._plug_back_append_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plug_back_tubes_per_reward() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._plug_back_eligible(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._plug_back_balance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._plug_back_lock(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._plug_back_void_restore() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plug_back_summary(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plug_back_record_return(uuid, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plug_back_redeem(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plug_back_tubes_per_reward() TO service_role;
GRANT EXECUTE ON FUNCTION public._plug_back_eligible(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._plug_back_balance(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._plug_back_lock(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.plug_back_summary(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.plug_back_record_return(uuid, uuid, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.plug_back_redeem(uuid, uuid, uuid, uuid, text) TO service_role;
