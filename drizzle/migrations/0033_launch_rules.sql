-- Prompt 14b (25 Oct 2026): launch rules.
--   * purchase_limits: optional per-member daily limit per category (items, or grams for products sold by weight),
--     counted over the South African day across online orders and till sales that name the member. Ships with no
--     limits (off); an admin turns each on. Enforced by triggers on order_items and pos_sale_items, so checkout,
--     reorder and the till are all covered without changing those functions. A walk-in till sale (no member chosen)
--     cannot be counted against anyone.
--   * verification_reset_attempts: an admin unlocks a member locked out after 5 rejected ID attempts, with a reason.
--   * products.low_stock_threshold (default 5) replaces the fixed 5 in the daily low-stock email.

-- ---------------------------------------------------------------------------
-- Purchase limits
-- ---------------------------------------------------------------------------

CREATE TABLE public.purchase_limits (
  category text PRIMARY KEY CHECK (category IN ('Flower', 'Pre-rolls', 'Edibles', 'Drinks', 'CBD', 'Vapes',
                                                'Concentrates', 'Accessories', 'Lounge')),
  daily_max integer NOT NULL CHECK (daily_max BETWEEN 1 AND 100000),
  enabled boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.purchase_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.purchase_limits FROM anon, authenticated;
GRANT ALL ON public.purchase_limits TO service_role;

-- Quantity of a category a member has bought today (SAST): open or completed online orders + till sales net of refunds.
CREATE OR REPLACE FUNCTION public._purchased_today(p_member uuid, p_category text)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT sum(oi.quantity) FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    JOIN public.products p ON p.id = oi.product_id
    WHERE o.user_id = p_member AND o.status <> 'cancelled' AND p.category = p_category
      AND (o.created_at AT TIME ZONE 'Africa/Johannesburg')::date = (now() AT TIME ZONE 'Africa/Johannesburg')::date
  ), 0) + COALESCE((
    SELECT sum(si.quantity - si.refunded_quantity) FROM public.pos_sale_items si
    JOIN public.pos_sales s ON s.id = si.sale_id
    JOIN public.products p ON p.id = si.product_id
    WHERE s.customer_id = p_member AND s.status <> 'voided' AND p.category = p_category
      AND (s.created_at AT TIME ZONE 'Africa/Johannesburg')::date = (now() AT TIME ZONE 'Africa/Johannesburg')::date
  ), 0);
$$;

CREATE OR REPLACE FUNCTION public._enforce_purchase_limit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_member uuid;
  v_limit public.purchase_limits;
  v_total bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.purchase_limits WHERE enabled) THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'order_items' THEN
    SELECT o.user_id INTO v_member FROM public.orders o WHERE o.id = NEW.order_id;
  ELSE
    SELECT s.customer_id INTO v_member FROM public.pos_sales s WHERE s.id = NEW.sale_id;
  END IF;
  IF v_member IS NULL THEN RETURN NULL; END IF;
  SELECT l.* INTO v_limit FROM public.purchase_limits l
  JOIN public.products p ON p.category = l.category
  WHERE p.id = NEW.product_id AND l.enabled;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- one member's purchases are counted one transaction at a time, so two tills cannot both slip under the limit
  PERFORM pg_advisory_xact_lock(hashtextextended('purchase_limit:' || v_member::text, 0));
  v_total := public._purchased_today(v_member, v_limit.category);
  IF v_total > v_limit.daily_max THEN
    RAISE EXCEPTION 'purchase_limit_exceeded: % is limited to % per day', v_limit.category, v_limit.daily_max
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
-- AFTER ... FOR EACH ROW runs once the whole statement's rows exist, so a basket is counted in full.
CREATE TRIGGER order_items_purchase_limit AFTER INSERT ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_purchase_limit();
CREATE TRIGGER pos_sale_items_purchase_limit AFTER INSERT ON public.pos_sale_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_purchase_limit();

CREATE OR REPLACE FUNCTION public.purchase_limit_set(
  p_actor uuid, p_category text, p_daily_max integer, p_enabled boolean, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_before public.purchase_limits;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  v_cached := public._idem_begin('purchase_limit_set', p_actor, p_idempotency_key,
    jsonb_build_object('c', p_category, 'm', p_daily_max, 'e', p_enabled));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_category IS NULL OR p_category NOT IN ('Flower', 'Pre-rolls', 'Edibles', 'Drinks', 'CBD', 'Vapes',
                                               'Concentrates', 'Accessories', 'Lounge') THEN
    RAISE EXCEPTION 'invalid_input: unknown category';
  END IF;
  IF p_daily_max IS NULL OR p_daily_max NOT BETWEEN 1 AND 100000 OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid_input: the daily limit must be between 1 and 100000';
  END IF;
  SELECT * INTO v_before FROM public.purchase_limits WHERE category = p_category FOR UPDATE;
  INSERT INTO public.purchase_limits (category, daily_max, enabled, updated_by, updated_at)
  VALUES (p_category, p_daily_max, p_enabled, p_actor, now())
  ON CONFLICT (category) DO UPDATE
    SET daily_max = EXCLUDED.daily_max, enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now();
  PERFORM public._audit(p_actor, 'purchase_limit_set', 'purchase_limit', NULL,
    jsonb_build_object('category', p_category, 'daily_max', p_daily_max, 'enabled', p_enabled,
                       'was', CASE WHEN v_before.category IS NULL THEN NULL
                                   ELSE jsonb_build_object('daily_max', v_before.daily_max, 'enabled', v_before.enabled) END));
  v_response := jsonb_build_object('category', p_category, 'daily_max', p_daily_max, 'enabled', p_enabled);
  RETURN public._idem_finish('purchase_limit_set', p_actor, p_idempotency_key, v_response);
END;
$$;

-- ---------------------------------------------------------------------------
-- ID lockout reset (admin, with a reason)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.verification_reset_attempts(
  p_actor uuid, p_member uuid, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c_max_attempts constant integer := 5; -- same as submit_id_verification
  v_cached jsonb;
  v_row public.customer_verification;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  IF p_member = p_actor THEN RAISE EXCEPTION 'self_review_forbidden: another admin must reset your attempts'; END IF;
  IF length(v_reason) NOT BETWEEN 10 AND 300 THEN
    RAISE EXCEPTION 'reason_required: give a reason of 10 to 300 characters';
  END IF;
  v_cached := public._idem_begin('verification_reset_attempts', p_actor, p_idempotency_key,
    jsonb_build_object('m', p_member, 'r', md5(v_reason)));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  SELECT * INTO v_row FROM public.customer_verification WHERE user_id = p_member FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'verification_not_found'; END IF;
  IF v_row.attempt_count < c_max_attempts OR v_row.status IN ('pending', 'verified') THEN
    RAISE EXCEPTION 'not_locked: this member is not locked out';
  END IF;
  UPDATE public.customer_verification SET attempt_count = 0, updated_at = now() WHERE user_id = p_member;
  PERFORM public._audit(p_actor, 'id_attempts_reset', 'customer_verification', p_member,
    jsonb_build_object('previous_attempts', v_row.attempt_count, 'reason', v_reason));
  v_response := jsonb_build_object('member', p_member, 'attempt_count', 0);
  RETURN public._idem_finish('verification_reset_attempts', p_actor, p_idempotency_key, v_response);
END;
$$;

-- ---------------------------------------------------------------------------
-- Per-product low-stock threshold
-- ---------------------------------------------------------------------------

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS low_stock_threshold integer NOT NULL DEFAULT 5
    CONSTRAINT products_low_stock_threshold_chk CHECK (low_stock_threshold BETWEEN 0 AND 100000);

-- The daily low-stock digest now uses each product's threshold (and skips Lounge services, which carry no stock).
CREATE OR REPLACE FUNCTION public.email_automations_run(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r record;
  v_back integer := 0;
  v_exp integer := 0;
  v_low integer := 0;
  v_digest integer := 0;
  v_items jsonb;
  v_articles jsonb;
  v_week text := to_char(p_now AT TIME ZONE 'Africa/Johannesburg', 'IYYY-IW');
BEGIN
  -- 1. back in stock: the claim flips subscriptions to 'notified' exactly once, so this cannot double-send
  FOR r IN
    SELECT (x->>'user_id')::uuid AS user_id, (x->>'product_id')::uuid AS product_id, x->>'id' AS sub_id
    FROM jsonb_array_elements(public.claim_back_in_stock_notifications(200)) x
  LOOP
    PERFORM public.notification_enqueue('email', 'back_in_stock',
      (SELECT u.email FROM auth.users u WHERE u.id = r.user_id), r.user_id, 'transactional',
      (SELECT jsonb_build_object('product_name', p.name, 'product_slug', p.slug, 'price_rand', p.price_rand)
       FROM public.products p WHERE p.id = r.product_id),
      'bis:' || r.sub_id)
    WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = r.user_id AND u.email IS NOT NULL);
    v_back := v_back + 1;
  END LOOP;

  -- 2. ID documents expiring within 30 days (passports / driver's licences; SA IDs have no expiry)
  FOR r IN
    SELECT v.user_id, v.document_expires_on, u.email, p.full_name
    FROM public.customer_verification v
    JOIN auth.users u ON u.id = v.user_id LEFT JOIN public.profiles p ON p.id = v.user_id
    WHERE v.status = 'verified' AND v.document_expires_on IS NOT NULL
      AND v.document_expires_on BETWEEN current_date AND current_date + 30 AND u.email IS NOT NULL
  LOOP
    IF public.notification_enqueue('email', 'id_expiring', r.email, r.user_id, 'transactional',
         jsonb_build_object('contact_name', r.full_name, 'document_expires_on', r.document_expires_on),
         'idexp:' || r.user_id::text || ':' || r.document_expires_on::text) IS NOT NULL THEN
      v_exp := v_exp + 1;
    END IF;
  END LOOP;

  -- 3. one low-stock digest per day for managers
  SELECT jsonb_agg(jsonb_build_object('name', name, 'available', available) ORDER BY available, name)
  INTO v_items
  FROM (SELECT p.name, public._product_available(p.id) AS available, p.low_stock_threshold
        FROM public.products p WHERE p.is_active AND p.track_stock) s
  WHERE available <= low_stock_threshold;
  IF v_items IS NOT NULL THEN
    v_low := public.notification_enqueue_staff('staff_low_stock', jsonb_build_object('items', v_items),
      'lowstock:' || current_date::text);
  END IF;

  -- 4. weekly Journal digest, Thursdays 06:00 SAST onwards, consenting subscribers only (one per week each)
  IF extract(isodow FROM p_now AT TIME ZONE 'Africa/Johannesburg') = 4 THEN
    SELECT jsonb_agg(jsonb_build_object('title', a.title, 'excerpt', a.excerpt, 'slug', a.slug, 'cover', a.cover_image_url)
                     ORDER BY a.published_at DESC)
    INTO v_articles
    FROM (SELECT * FROM public.articles ORDER BY published_at DESC LIMIT 3) a;
    IF v_articles IS NOT NULL THEN
      FOR r IN SELECT id, email, unsubscribe_token FROM public.newsletter_subscribers WHERE unsubscribed_at IS NULL
      LOOP
        IF public.notification_enqueue('email', 'journal_digest', r.email, NULL, 'marketing',
             jsonb_build_object('consent', 'true', 'articles', v_articles, 'unsubscribe_token', r.unsubscribe_token),
             'digest:' || v_week || ':' || r.id::text) IS NOT NULL THEN
          v_digest := v_digest + 1;
        END IF;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object('back_in_stock', v_back, 'id_expiring', v_exp, 'low_stock_alerts', COALESCE(v_low, 0),
                            'journal_digest', v_digest);
END;
$$;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._purchased_today(uuid, text)',
    'public._enforce_purchase_limit()',
    'public.purchase_limit_set(uuid, text, integer, boolean, text)',
    'public.verification_reset_attempts(uuid, uuid, text, text)',
    'public.email_automations_run(timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;
