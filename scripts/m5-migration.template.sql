-- Milestone 5: payments and notifications as production infrastructure.
--
--   * fx_rates / payment_settings   manager-set PayPal ZAR->USD rate (PayPal cannot charge ZAR), EFT dual-control limit
--   * payment_transactions          one row per payment attempt, with the AUTHORITATIVE expected amount/currency/merchant
--   * webhook_events                one row per verified provider event; UNIQUE (provider, event_key) = replay guard
--   * webhook_rejections            audit trail of messages refused before any business logic
--   * payment_initiate              server-side initiation from the order's authoritative total
--   * payments_apply_verified_event the ONLY path that marks a provider payment paid: compare, then confirm_order_payment
--   * eft_submit / eft_approve      manual EFT as a controlled staff workflow (manager+, dual control above a limit)
--   * notification_events           durable queue + retry for email / SMS / WhatsApp (never sent from UI render paths)
--   * order lifecycle triggers      member/staff notifications, idempotent, and incapable of failing an order
--   * transition_order_status       can no longer confirm an UNPAID order (that needs a verified payment)
--   * checkout_place_order          accepts eft / card / paypal (provider availability is enforced server-side)
--
-- Nothing here trusts the browser: a return URL never marks anything paid.

-- ---------------------------------------------------------------------------
-- Settings and FX
-- ---------------------------------------------------------------------------

CREATE TABLE public.payment_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.payment_settings (key, value) VALUES
  ('eft_dual_control_threshold_rand', '10000'::jsonb),
  ('sms_enabled', 'false'::jsonb),
  ('whatsapp_enabled', 'false'::jsonb);

CREATE TABLE public.fx_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency text NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency text NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  -- base units per 1 quote unit, e.g. ZAR per 1 USD
  rate numeric(14,6) NOT NULL CHECK (rate > 0),
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 2 AND 200),
  set_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  valid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (base_currency <> quote_currency)
);
CREATE INDEX fx_rates_lookup_idx ON public.fx_rates (base_currency, quote_currency, created_at DESC);

CREATE OR REPLACE FUNCTION public.fx_set_rate(
  p_actor uuid, p_base text, p_quote text, p_rate numeric, p_valid_hours integer, p_source text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);
  IF p_base !~ '^[A-Z]{3}$' OR p_quote !~ '^[A-Z]{3}$' OR p_base = p_quote THEN
    RAISE EXCEPTION 'invalid_currency_pair';
  END IF;
  IF p_rate IS NULL OR p_rate <= 0 THEN RAISE EXCEPTION 'invalid_rate'; END IF;
  -- Sanity bound for the one pair we use: a fat-fingered 1.8 or 1825 must not become a price.
  IF p_base = 'ZAR' AND p_quote = 'USD' AND p_rate NOT BETWEEN 5 AND 60 THEN
    RAISE EXCEPTION 'invalid_rate: ZAR per USD must be between 5 and 60';
  END IF;
  IF p_valid_hours IS NULL OR p_valid_hours NOT BETWEEN 1 AND 168 THEN
    RAISE EXCEPTION 'invalid_validity: 1 to 168 hours';
  END IF;
  INSERT INTO public.fx_rates (base_currency, quote_currency, rate, source, set_by, valid_until)
  VALUES (p_base, p_quote, round(p_rate, 6), btrim(p_source), p_actor, now() + make_interval(hours => p_valid_hours))
  RETURNING id INTO v_id;
  PERFORM public._audit(p_actor, 'fx_rate_set', 'fx_rate', v_id,
    jsonb_build_object('pair', p_base || '/' || p_quote, 'rate', p_rate, 'valid_hours', p_valid_hours, 'source', p_source));
  RETURN jsonb_build_object('id', v_id, 'rate', round(p_rate, 6));
END;
$$;

CREATE OR REPLACE FUNCTION public.fx_current_rate(p_base text, p_quote text)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_rate numeric;
BEGIN
  SELECT f.rate INTO v_rate FROM public.fx_rates f
  WHERE f.base_currency = p_base AND f.quote_currency = p_quote AND f.valid_until > now()
  ORDER BY f.created_at DESC LIMIT 1;
  IF v_rate IS NULL THEN
    RAISE EXCEPTION 'fx_rate_unavailable: no current % per % rate has been set', p_base, p_quote;
  END IF;
  RETURN v_rate;
END;
$$;

-- ---------------------------------------------------------------------------
-- Payment transactions
-- ---------------------------------------------------------------------------

CREATE TABLE public.payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('paypal', 'yoco', 'eft')),
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('test', 'live')),
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN
    ('initiated', 'pending', 'pending_approval', 'succeeded', 'failed', 'cancelled', 'expired', 'review', 'needs_refund')),
  -- What the order was worth in rand when payment started, and what we told the provider to collect.
  order_total_rand numeric(10,2) NOT NULL CHECK (order_total_rand > 0),
  expected_amount numeric(12,2) NOT NULL CHECK (expected_amount > 0),
  expected_currency text NOT NULL CHECK (expected_currency ~ '^[A-Z]{3}$'),
  fx_rate numeric(14,6) CHECK (fx_rate IS NULL OR fx_rate > 0),
  expected_merchant_id text,
  provider_ref text,
  provider_payment_id text,
  redirect_url text,
  idempotency_key text,
  failure_reason text,
  received_amount numeric(12,2),
  received_currency text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '45 minutes'),
  completed_at timestamptz,
  CONSTRAINT payment_transactions_fx_chk CHECK ((expected_currency = 'ZAR') = (fx_rate IS NULL))
);
CREATE INDEX payment_transactions_order_idx ON public.payment_transactions (order_id, created_at DESC);
CREATE INDEX payment_transactions_status_idx ON public.payment_transactions (status, updated_at DESC);
CREATE UNIQUE INDEX payment_transactions_provider_ref_uq
  ON public.payment_transactions (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE UNIQUE INDEX payment_transactions_provider_payment_uq
  ON public.payment_transactions (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX payment_transactions_idem_uq
  ON public.payment_transactions (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND provider <> 'eft';
-- An order is paid at most once.
CREATE UNIQUE INDEX payment_transactions_one_success_per_order
  ON public.payment_transactions (order_id) WHERE status = 'succeeded';

CREATE TABLE public.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('paypal', 'yoco')),
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 4 AND 200),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 2 AND 120),
  mode text,
  transaction_id uuid REFERENCES public.payment_transactions(id) ON DELETE SET NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'rejected')),
  outcome text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  -- The replay guard: the same provider event can never be recorded (or processed) twice.
  CONSTRAINT webhook_events_provider_event_uq UNIQUE (provider, event_key)
);
CREATE INDEX webhook_events_tx_idx ON public.webhook_events (transaction_id);
CREATE INDEX webhook_events_status_idx ON public.webhook_events (status, received_at DESC);

CREATE TABLE public.webhook_rejections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL,
  reason text NOT NULL,
  source_ip_hash text,
  event_key_hint text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public._webhook_events_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'webhook_events are append-only';
  END IF;
  IF NEW.provider <> OLD.provider OR NEW.event_key <> OLD.event_key OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.event_type <> OLD.event_type OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'webhook_events identity and payload are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_events_guard BEFORE UPDATE OR DELETE ON public.webhook_events
  FOR EACH ROW EXECUTE FUNCTION public._webhook_events_guard();

CREATE OR REPLACE FUNCTION public.webhook_reject(p_provider text, p_reason text, p_ip_hash text, p_event_key_hint text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO public.webhook_rejections (provider, reason, source_ip_hash, event_key_hint)
  VALUES (left(COALESCE(p_provider, 'unknown'), 40), left(COALESCE(p_reason, 'unspecified'), 200),
          left(p_ip_hash, 80), left(p_event_key_hint, 200));
$$;

-- ---------------------------------------------------------------------------
-- Notification queue (declared early: the payment functions enqueue staff alerts)
-- ---------------------------------------------------------------------------

CREATE TABLE public.notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  category text NOT NULL DEFAULT 'transactional' CHECK (category IN ('transactional', 'staff', 'marketing')),
  template text NOT NULL CHECK (template ~ '^[a-z0-9_]{3,60}$'),
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 5 AND 254),
  recipient_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 4 AND 250),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'dead', 'suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  priority smallint NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT notification_events_dedupe_uq UNIQUE (dedupe_key)
);
CREATE INDEX notification_events_due_idx ON public.notification_events (status, next_attempt_at)
  WHERE status IN ('queued', 'failed', 'sending');

CREATE OR REPLACE FUNCTION public.notification_enqueue(
  p_channel text, p_template text, p_recipient text, p_user_id uuid, p_category text,
  p_data jsonb, p_dedupe_key text, p_delay_seconds integer DEFAULT 0
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_category = 'marketing' AND COALESCE(p_data->>'consent', 'false') <> 'true' THEN
    RAISE EXCEPTION 'marketing_consent_required: marketing messages need recorded consent';
  END IF;
  INSERT INTO public.notification_events
    (channel, category, template, recipient, recipient_user_id, data, dedupe_key, next_attempt_at)
  VALUES (p_channel, p_category, p_template, btrim(p_recipient), p_user_id, COALESCE(p_data, '{}'::jsonb),
          p_dedupe_key, now() + make_interval(secs => GREATEST(COALESCE(p_delay_seconds, 0), 0)))
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;  -- NULL when this exact notification was already queued (idempotent)
END;
$$;

CREATE OR REPLACE FUNCTION public.notification_enqueue_staff(
  p_template text, p_data jsonb, p_dedupe_key text, p_min_role public.app_role DEFAULT 'manager'
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT u.id, u.email
    FROM auth.users u JOIN public.user_roles ur ON ur.user_id = u.id
    WHERE public.role_level(ur.role) >= public.role_level(p_min_role) AND u.email IS NOT NULL
  LOOP
    IF public.notification_enqueue('email', p_template, r.email, r.id, 'staff', p_data,
                                   p_dedupe_key || ':' || r.id::text) IS NOT NULL THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- Claims due work with FOR UPDATE SKIP LOCKED, so concurrent dispatchers never double-send, and a
-- crashed dispatcher's lease simply expires.
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

CREATE OR REPLACE FUNCTION public.notification_complete(
  p_id uuid, p_ok boolean, p_provider_message_id text, p_error text, p_permanent boolean DEFAULT false
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v public.notification_events;
  v_status text;
BEGIN
  SELECT * INTO v FROM public.notification_events WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'notification_not_found'; END IF;
  IF v.status <> 'sending' THEN
    RETURN v.status;  -- a late or duplicate completion changes nothing
  END IF;
  IF p_ok THEN
    v_status := 'sent';
    UPDATE public.notification_events
    SET status = 'sent', sent_at = now(), locked_until = NULL, provider_message_id = left(p_provider_message_id, 200),
        last_error = NULL
    WHERE id = p_id;
  ELSIF p_permanent OR v.attempts >= v.max_attempts THEN
    v_status := 'dead';
    UPDATE public.notification_events SET status = 'dead', locked_until = NULL, last_error = left(p_error, 500)
    WHERE id = p_id;
  ELSE
    v_status := 'failed';
    -- exponential backoff: 1m, 2m, 4m ... capped at one hour
    UPDATE public.notification_events
    SET status = 'failed', locked_until = NULL, last_error = left(p_error, 500),
        next_attempt_at = now() + make_interval(secs => LEAST(3600, 60 * (2 ^ (v.attempts - 1))::integer))
    WHERE id = p_id;
  END IF;
  RETURN v_status;
END;
$$;

-- ---------------------------------------------------------------------------
-- Payment initiation (server-side, from the order's authoritative total)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.payment_initiate(
  p_user_id uuid, p_order_id uuid, p_provider text, p_mode text, p_merchant_id text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_order public.orders;
  v_existing public.payment_transactions;
  v_tx public.payment_transactions;
  v_rate numeric;
  v_amount numeric(12,2);
  v_currency text;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  IF p_provider IS NULL OR p_provider NOT IN ('paypal', 'yoco') THEN RAISE EXCEPTION 'invalid_provider'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('test', 'live') THEN RAISE EXCEPTION 'invalid_mode'; END IF;
  PERFORM public._require_verified_member(p_user_id);
  v_cached := public._idem_begin('payment_initiate', p_user_id, p_idempotency_key,
    jsonb_build_object('order', p_order_id, 'provider', p_provider, 'mode', p_mode));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  -- Ownership is part of the lookup; the row lock serialises concurrent initiations for one order.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v_order.status <> 'awaiting_payment' THEN
    RAISE EXCEPTION 'order_not_payable: this order is not awaiting payment';
  END IF;
  IF v_order.total_rand IS NULL OR v_order.total_rand <= 0 THEN
    RAISE EXCEPTION 'order_not_payable: this order has nothing to pay';
  END IF;

  SELECT * INTO v_existing FROM public.payment_transactions
  WHERE order_id = p_order_id AND provider = p_provider AND status IN ('initiated', 'pending') AND expires_at > now()
  ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    IF v_existing.order_total_rand = v_order.total_rand AND v_existing.mode = p_mode THEN
      v_response := jsonb_build_object('transaction_id', v_existing.id, 'provider', v_existing.provider,
        'status', v_existing.status, 'expected_amount', v_existing.expected_amount,
        'expected_currency', v_existing.expected_currency, 'fx_rate', v_existing.fx_rate,
        'redirect_url', v_existing.redirect_url, 'order_number', v_order.order_number, 'reused', true);
      RETURN public._idem_finish('payment_initiate', p_user_id, p_idempotency_key, v_response);
    END IF;
    UPDATE public.payment_transactions SET status = 'cancelled', failure_reason = 'superseded', updated_at = now()
    WHERE id = v_existing.id;
  END IF;

  IF p_provider = 'yoco' THEN
    v_currency := 'ZAR';
    v_amount := v_order.total_rand;
    v_rate := NULL;
  ELSE
    -- PayPal does not support ZAR: charge USD at the current manager-set rate, rounded UP to the cent so
    -- conversion can never under-collect. The rate is stored on the transaction.
    v_rate := public.fx_current_rate('ZAR', 'USD');
    v_currency := 'USD';
    v_amount := (ceil(v_order.total_rand / v_rate * 100) / 100)::numeric(12,2);
  END IF;

  INSERT INTO public.payment_transactions
    (order_id, user_id, provider, mode, order_total_rand, expected_amount, expected_currency, fx_rate,
     expected_merchant_id, idempotency_key, created_by)
  VALUES (p_order_id, p_user_id, p_provider, p_mode, v_order.total_rand, v_amount, v_currency, v_rate,
          NULLIF(btrim(COALESCE(p_merchant_id, '')), ''), p_idempotency_key, p_user_id)
  RETURNING * INTO v_tx;

  PERFORM public._audit(p_user_id, 'payment_initiated', 'payment_transaction', v_tx.id,
    jsonb_build_object('order_id', p_order_id, 'provider', p_provider, 'amount', v_amount, 'currency', v_currency));
  v_response := jsonb_build_object('transaction_id', v_tx.id, 'provider', v_tx.provider, 'status', v_tx.status,
    'expected_amount', v_tx.expected_amount, 'expected_currency', v_tx.expected_currency, 'fx_rate', v_tx.fx_rate,
    'redirect_url', NULL, 'order_number', v_order.order_number, 'reused', false);
  RETURN public._idem_finish('payment_initiate', p_user_id, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_attach_session(p_transaction_id uuid, p_provider_ref text, p_redirect_url text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v public.payment_transactions;
BEGIN
  IF p_provider_ref IS NULL OR length(p_provider_ref) NOT BETWEEN 3 AND 200 THEN
    RAISE EXCEPTION 'invalid_provider_ref';
  END IF;
  SELECT * INTO v FROM public.payment_transactions WHERE id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction_not_found'; END IF;
  IF v.status = 'initiated' THEN
    UPDATE public.payment_transactions
    SET provider_ref = p_provider_ref, redirect_url = left(p_redirect_url, 2000), status = 'pending', updated_at = now()
    WHERE id = p_transaction_id;
  ELSIF v.provider_ref IS DISTINCT FROM p_provider_ref THEN
    RAISE EXCEPTION 'transaction_not_attachable: it is %', v.status;
  END IF;
  RETURN jsonb_build_object('transaction_id', p_transaction_id, 'status', 'pending');
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_mark_failed(p_transaction_id uuid, p_reason text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE public.payment_transactions
  SET status = 'failed', failure_reason = left(p_reason, 300), updated_at = now()
  WHERE id = p_transaction_id AND status IN ('initiated', 'pending');
$$;

CREATE OR REPLACE FUNCTION public.payments_expire_stale()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.payment_transactions SET status = 'expired', updated_at = now()
  WHERE status IN ('initiated', 'pending') AND expires_at < now() - interval '24 hours';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- The only path that marks a provider payment as paid
-- ---------------------------------------------------------------------------

-- p_facts is produced by the provider adapter AFTER signature/hash verification:
--   kind              payment_succeeded | payment_failed | payment_refunded | ignored
--   transaction_id    OUR reference, round-tripped through the provider (metadata / custom_id)
--   provider_ref      provider checkout / order id (optional on some events)
--   provider_payment_id   the provider's payment / capture id (the idempotency reference for stock + loyalty)
--   amount_minor, currency, mode, merchant_id
CREATE OR REPLACE FUNCTION public.payments_apply_verified_event(
  p_provider text, p_event_key text, p_event_type text, p_payload jsonb, p_facts jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event public.webhook_events;
  v_inserted uuid;
  v_kind text := p_facts->>'kind';
  v_tx public.payment_transactions;
  v_order public.orders;
  v_tx_id uuid;
  v_mismatch text;
  v_amount_minor bigint;
  v_res jsonb;
  v_outcome text;
  v_tx_status text;
  v_pay_provider text;
BEGIN
  PERFORM public._require_read_committed();
  IF p_provider IS NULL OR p_provider NOT IN ('paypal', 'yoco')
     OR p_event_key IS NULL OR length(p_event_key) NOT BETWEEN 4 AND 200
     OR p_event_type IS NULL OR length(p_event_type) NOT BETWEEN 2 AND 120
     OR p_payload IS NULL OR p_facts IS NULL
     OR v_kind IS NULL OR v_kind NOT IN ('payment_succeeded', 'payment_failed', 'payment_refunded', 'ignored') THEN
    RAISE EXCEPTION 'invalid_webhook_event';
  END IF;

  -- Replay guard: concurrent deliveries of the same event serialise on the unique index; the loser sees
  -- no inserted row and returns the recorded result without touching stock, loyalty or the order.
  INSERT INTO public.webhook_events (provider, event_key, event_type, mode, payload)
  VALUES (p_provider, p_event_key, p_event_type, NULLIF(p_facts->>'mode', ''), p_payload)
  ON CONFLICT ON CONSTRAINT webhook_events_provider_event_uq DO NOTHING
  RETURNING id INTO v_inserted;
  IF v_inserted IS NULL THEN
    SELECT * INTO v_event FROM public.webhook_events WHERE provider = p_provider AND event_key = p_event_key;
    RETURN jsonb_build_object('replayed', true, 'status', v_event.status, 'outcome', v_event.outcome,
                              'transaction_id', v_event.transaction_id);
  END IF;

  IF v_kind = 'ignored' THEN
    UPDATE public.webhook_events SET status = 'ignored', outcome = 'ignored_event_type', processed_at = now()
    WHERE id = v_inserted;
    RETURN jsonb_build_object('replayed', false, 'status', 'ignored', 'outcome', 'ignored_event_type');
  END IF;

  BEGIN
    v_tx_id := (p_facts->>'transaction_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_tx_id := NULL;
  END;
  IF v_tx_id IS NOT NULL THEN
    SELECT * INTO v_tx FROM public.payment_transactions
    WHERE id = v_tx_id AND provider = p_provider FOR UPDATE;
  END IF;
  IF v_tx.id IS NULL THEN
    UPDATE public.webhook_events SET status = 'rejected', outcome = 'unknown_transaction', processed_at = now()
    WHERE id = v_inserted;
    PERFORM public.notification_enqueue_staff('staff_payment_review',
      jsonb_build_object('reason', 'A verified ' || p_provider || ' event referenced no known transaction',
                         'event_key', p_event_key), 'payreview:' || p_provider || ':' || p_event_key);
    RETURN jsonb_build_object('replayed', false, 'status', 'rejected', 'outcome', 'unknown_transaction');
  END IF;

  IF v_kind = 'payment_failed' THEN
    UPDATE public.payment_transactions
    SET status = 'failed', failure_reason = left(COALESCE(p_facts->>'reason', 'provider reported a failed payment'), 300),
        updated_at = now()
    WHERE id = v_tx.id AND status IN ('initiated', 'pending');
    v_outcome := 'failed_recorded';
  ELSIF v_kind = 'payment_refunded' THEN
    -- Money went back to the customer outside our flow: record it and make sure a person looks.
    UPDATE public.payment_transactions
    SET meta = meta || jsonb_build_object('refund_event', p_event_key), updated_at = now() WHERE id = v_tx.id;
    PERFORM public.notification_enqueue_staff('staff_payment_review',
      jsonb_build_object('reason', 'A ' || p_provider || ' refund was reported', 'order_id', v_tx.order_id,
                         'transaction_id', v_tx.id), 'payrefund:' || p_provider || ':' || p_event_key);
    v_outcome := 'refund_recorded_needs_review';
  ELSE
    -- payment_succeeded: compare the VERIFIED event with what we asked the provider to collect.
    SELECT * INTO v_order FROM public.orders WHERE id = v_tx.order_id FOR UPDATE;
    v_amount_minor := NULLIF(p_facts->>'amount_minor', '')::bigint;
    IF p_facts->>'provider_payment_id' IS NULL OR length(p_facts->>'provider_payment_id') NOT BETWEEN 4 AND 200 THEN
      v_mismatch := 'missing_payment_id';
    ELSIF v_tx.provider_ref IS NOT NULL AND p_facts->>'provider_ref' IS NOT NULL
          AND v_tx.provider_ref <> p_facts->>'provider_ref' THEN
      v_mismatch := 'reference_mismatch';
    ELSIF v_amount_minor IS NULL OR v_amount_minor <> round(v_tx.expected_amount * 100)::bigint THEN
      v_mismatch := 'amount_mismatch';
    ELSIF p_facts->>'currency' IS DISTINCT FROM v_tx.expected_currency THEN
      v_mismatch := 'currency_mismatch';
    ELSIF p_facts->>'mode' IS DISTINCT FROM v_tx.mode THEN
      v_mismatch := 'mode_mismatch';
    ELSIF v_tx.expected_merchant_id IS NOT NULL AND p_facts->>'merchant_id' IS DISTINCT FROM v_tx.expected_merchant_id THEN
      v_mismatch := 'merchant_mismatch';
    ELSIF v_order.id IS NULL OR v_order.total_rand IS DISTINCT FROM v_tx.order_total_rand THEN
      v_mismatch := 'order_total_changed';
    END IF;

    IF v_mismatch IS NOT NULL THEN
      UPDATE public.payment_transactions
      SET status = 'review', failure_reason = v_mismatch, updated_at = now(),
          received_amount = CASE WHEN v_amount_minor IS NULL THEN NULL ELSE v_amount_minor / 100.0 END,
          received_currency = left(p_facts->>'currency', 3)
      WHERE id = v_tx.id AND status NOT IN ('succeeded');
      PERFORM public._audit(NULL, 'payment_event_rejected', 'payment_transaction', v_tx.id,
        jsonb_build_object('reason', v_mismatch, 'provider', p_provider, 'event_key', p_event_key));
      PERFORM public.notification_enqueue_staff('staff_payment_review',
        jsonb_build_object('reason', 'Payment mismatch: ' || v_mismatch, 'order_id', v_tx.order_id,
                           'transaction_id', v_tx.id), 'paymismatch:' || p_provider || ':' || p_event_key);
      v_outcome := 'rejected_' || v_mismatch;
      UPDATE public.webhook_events
      SET status = 'rejected', outcome = v_outcome, transaction_id = v_tx.id, processed_at = now()
      WHERE id = v_inserted;
      RETURN jsonb_build_object('replayed', false, 'status', 'rejected', 'outcome', v_outcome,
                                'transaction_id', v_tx.id);
    END IF;

    -- Idempotent per provider payment id: confirm_order_payment consumes stock once, whatever number of
    -- distinct events (ORDER.APPROVED, CAPTURE.COMPLETED, retries...) report the same payment.
    v_pay_provider := CASE p_provider WHEN 'paypal' THEN 'paypal' ELSE 'card' END;
    v_res := public.confirm_order_payment(v_pay_provider, p_facts->>'provider_payment_id', v_tx.order_id,
                                          v_tx.order_total_rand);
    v_outcome := v_res->>'outcome';
    v_tx_status := CASE v_outcome
      WHEN 'confirmed' THEN 'succeeded'
      WHEN 'paid_after_cancel_needs_refund' THEN 'needs_refund'
      WHEN 'stock_unavailable_needs_refund' THEN 'needs_refund'
      WHEN 'already_processed' THEN 'needs_refund'   -- the order was already paid by something else
      ELSE 'review' END;
    IF (v_res->>'duplicate')::boolean AND v_outcome = 'confirmed' THEN
      v_tx_status := 'succeeded';
    END IF;
    UPDATE public.payment_transactions
    SET status = v_tx_status, provider_payment_id = p_facts->>'provider_payment_id',
        provider_ref = COALESCE(provider_ref, NULLIF(p_facts->>'provider_ref', '')),
        received_amount = v_amount_minor / 100.0, received_currency = p_facts->>'currency',
        completed_at = now(), updated_at = now(),
        failure_reason = CASE WHEN v_tx_status = 'succeeded' THEN NULL ELSE v_outcome END
    WHERE id = v_tx.id;
    IF v_tx_status = 'succeeded' THEN
      UPDATE public.payment_transactions SET status = 'cancelled', failure_reason = 'order_paid', updated_at = now()
      WHERE order_id = v_tx.order_id AND id <> v_tx.id AND status IN ('initiated', 'pending');
    ELSIF v_tx_status = 'needs_refund' THEN
      PERFORM public.notification_enqueue_staff('staff_refund_needed',
        jsonb_build_object('reason', v_outcome, 'order_id', v_tx.order_id, 'transaction_id', v_tx.id),
        'payrefundneeded:' || v_tx.id::text);
    END IF;
  END IF;

  UPDATE public.webhook_events
  SET status = 'processed', outcome = v_outcome, transaction_id = v_tx.id, processed_at = now()
  WHERE id = v_inserted;
  PERFORM public._audit(NULL, 'payment_event_processed', 'payment_transaction', v_tx.id,
    jsonb_build_object('provider', p_provider, 'event_key', p_event_key, 'outcome', v_outcome));
  RETURN jsonb_build_object('replayed', false, 'status', 'processed', 'outcome', v_outcome, 'transaction_id', v_tx.id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Manual EFT: a controlled staff workflow (manager+, dual control above a limit, audited)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._eft_threshold()
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE((SELECT (value #>> '{}')::numeric FROM public.payment_settings
                   WHERE key = 'eft_dual_control_threshold_rand'), 10000);
$$;

CREATE OR REPLACE FUNCTION public._eft_settle(p_tx public.payment_transactions, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_res jsonb;
  v_outcome text;
  v_status text;
BEGIN
  v_res := public.confirm_order_payment('eft', p_tx.provider_payment_id, p_tx.order_id, p_tx.expected_amount);
  v_outcome := v_res->>'outcome';
  v_status := CASE v_outcome WHEN 'confirmed' THEN 'succeeded'
                             WHEN 'paid_after_cancel_needs_refund' THEN 'needs_refund'
                             WHEN 'stock_unavailable_needs_refund' THEN 'needs_refund'
                             ELSE 'review' END;
  UPDATE public.payment_transactions
  SET status = v_status, completed_at = now(), updated_at = now(),
      received_amount = expected_amount, received_currency = 'ZAR',
      failure_reason = CASE WHEN v_status = 'succeeded' THEN NULL ELSE v_outcome END
  WHERE id = p_tx.id;
  PERFORM public._audit(p_actor, 'eft_payment_settled', 'payment_transaction', p_tx.id,
    jsonb_build_object('outcome', v_outcome, 'order_id', p_tx.order_id, 'amount', p_tx.expected_amount));
  IF v_status = 'needs_refund' THEN
    PERFORM public.notification_enqueue_staff('staff_refund_needed',
      jsonb_build_object('reason', v_outcome, 'order_id', p_tx.order_id, 'transaction_id', p_tx.id),
      'payrefundneeded:' || p_tx.id::text);
  END IF;
  RETURN jsonb_build_object('outcome', v_outcome, 'status', v_status, 'transaction_id', p_tx.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.eft_submit(
  p_actor uuid, p_order_id uuid, p_bank_reference text, p_amount numeric, p_received_on date,
  p_note text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_order public.orders;
  v_tx public.payment_transactions;
  v_ref text := btrim(COALESCE(p_bank_reference, ''));
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);
  IF v_ref !~ '^[A-Za-z0-9 ._/-]{4,100}$' THEN
    RAISE EXCEPTION 'invalid_bank_reference: 4-100 letters, digits, spaces or . _ / -';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'invalid_amount: a positive amount with at most 2 decimals is required';
  END IF;
  IF p_received_on IS NULL OR p_received_on > current_date OR p_received_on < current_date - 60 THEN
    RAISE EXCEPTION 'invalid_received_date: the date the money reached the account (within the last 60 days)';
  END IF;
  IF p_note IS NOT NULL AND length(p_note) > 500 THEN RAISE EXCEPTION 'note_too_long'; END IF;

  v_cached := public._idem_begin('eft_submit', p_actor, p_idempotency_key,
    jsonb_build_object('order', p_order_id, 'ref', v_ref, 'amount', p_amount, 'on', p_received_on));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM public.payment_transactions
             WHERE provider = 'eft' AND provider_payment_id = v_ref) THEN
    RAISE EXCEPTION 'bank_reference_in_use: that reference was already recorded';
  END IF;
  IF v_order.status <> 'awaiting_payment' THEN
    v_response := jsonb_build_object('outcome',
      CASE WHEN v_order.status = 'cancelled' THEN 'paid_after_cancel_needs_refund' ELSE 'already_processed' END);
    RETURN public._idem_finish('eft_submit', p_actor, p_idempotency_key, v_response);
  END IF;

  INSERT INTO public.payment_transactions
    (order_id, user_id, provider, mode, status, order_total_rand, expected_amount, expected_currency,
     provider_payment_id, created_by, meta, expires_at)
  VALUES (p_order_id, v_order.user_id, 'eft', 'live',
          CASE WHEN p_amount IS DISTINCT FROM v_order.total_rand THEN 'review'
               WHEN p_amount >= public._eft_threshold() THEN 'pending_approval' ELSE 'initiated' END,
          v_order.total_rand, p_amount, 'ZAR',
          CASE WHEN p_amount IS DISTINCT FROM v_order.total_rand THEN NULL ELSE v_ref END,
          p_actor,
          jsonb_build_object('bank_reference', v_ref, 'received_on', p_received_on, 'note', p_note),
          now() + interval '30 days')
  RETURNING * INTO v_tx;

  IF p_amount IS DISTINCT FROM v_order.total_rand THEN
    UPDATE public.payment_transactions SET failure_reason = 'amount_mismatch' WHERE id = v_tx.id;
    PERFORM public._audit(p_actor, 'eft_amount_mismatch', 'payment_transaction', v_tx.id,
      jsonb_build_object('order_total', v_order.total_rand, 'received', p_amount));
    v_response := jsonb_build_object('outcome', 'amount_mismatch', 'status', 'review', 'transaction_id', v_tx.id);
  ELSIF v_tx.status = 'pending_approval' THEN
    PERFORM public._audit(p_actor, 'eft_awaiting_second_approval', 'payment_transaction', v_tx.id,
      jsonb_build_object('order_id', p_order_id, 'amount', p_amount));
    PERFORM public.notification_enqueue_staff('staff_eft_approval',
      jsonb_build_object('order_id', p_order_id, 'amount', p_amount, 'transaction_id', v_tx.id),
      'eftapproval:' || v_tx.id::text);
    v_response := jsonb_build_object('outcome', 'pending_approval', 'status', 'pending_approval',
                                     'transaction_id', v_tx.id);
  ELSE
    v_response := public._eft_settle(v_tx, p_actor);
  END IF;
  RETURN public._idem_finish('eft_submit', p_actor, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.eft_approve(p_actor uuid, p_transaction_id uuid, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_tx public.payment_transactions;
  v_order public.orders;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);
  v_cached := public._idem_begin('eft_approve', p_actor, p_idempotency_key, jsonb_build_object('tx', p_transaction_id));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;
  SELECT * INTO v_tx FROM public.payment_transactions WHERE id = p_transaction_id AND provider = 'eft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction_not_found'; END IF;
  IF v_tx.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'not_pending_approval: this EFT is %', v_tx.status;
  END IF;
  IF v_tx.created_by = p_actor THEN
    RAISE EXCEPTION 'dual_control_required: a different manager must approve this EFT' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = v_tx.order_id FOR UPDATE;
  IF v_order.total_rand IS DISTINCT FROM v_tx.order_total_rand THEN
    UPDATE public.payment_transactions SET status = 'review', failure_reason = 'order_total_changed', updated_at = now()
    WHERE id = v_tx.id;
    v_response := jsonb_build_object('outcome', 'order_total_changed', 'status', 'review', 'transaction_id', v_tx.id);
  ELSE
    UPDATE public.payment_transactions SET approved_by = p_actor WHERE id = v_tx.id RETURNING * INTO v_tx;
    v_response := public._eft_settle(v_tx, p_actor);
  END IF;
  RETURN public._idem_finish('eft_approve', p_actor, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.eft_reject(p_actor uuid, p_transaction_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_tx public.payment_transactions;
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'reason_required: say why this EFT is being rejected';
  END IF;
  SELECT * INTO v_tx FROM public.payment_transactions WHERE id = p_transaction_id AND provider = 'eft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction_not_found'; END IF;
  IF v_tx.status NOT IN ('pending_approval', 'review') THEN
    RAISE EXCEPTION 'not_rejectable: this EFT is %', v_tx.status;
  END IF;
  UPDATE public.payment_transactions
  SET status = 'failed', failure_reason = left(btrim(p_reason), 300), updated_at = now(), provider_payment_id = NULL
  WHERE id = v_tx.id;
  PERFORM public._audit(p_actor, 'eft_rejected', 'payment_transaction', v_tx.id,
    jsonb_build_object('reason', p_reason, 'order_id', v_tx.order_id));
  RETURN jsonb_build_object('status', 'failed', 'transaction_id', v_tx.id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Order lifecycle notifications (idempotent; can never fail an order)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._notify_order_status()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
  v_email text;
  v_template text;
  v_data jsonb;
  v_phone text;
  v_sms boolean;
BEGIN
  BEGIN
    SELECT * INTO v_order FROM public.orders WHERE id = NEW.order_id;
    IF NOT FOUND THEN RETURN NEW; END IF;
    v_template := CASE NEW.to_status
      WHEN 'awaiting_payment' THEN 'order_received'
      WHEN 'confirmed' THEN 'order_confirmed'
      WHEN 'ready' THEN 'order_ready'
      WHEN 'out_for_delivery' THEN 'order_out_for_delivery'
      WHEN 'completed' THEN 'order_completed'
      WHEN 'cancelled' THEN 'order_cancelled'
      ELSE NULL END;
    IF v_template IS NULL THEN RETURN NEW; END IF;
    v_data := jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
      'total_rand', v_order.total_rand, 'contact_name', v_order.contact_name,
      'delivery_method', v_order.delivery_method, 'payment_method', v_order.payment_method, 'status', NEW.to_status);
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_order.user_id;
    IF v_email IS NOT NULL THEN
      PERFORM public.notification_enqueue('email', v_template, v_email, v_order.user_id, 'transactional', v_data,
                                          'order:' || NEW.id::text || ':email');
    END IF;
    -- Optional text messages, only for the two moments they matter and only if the channel is switched on.
    IF NEW.to_status IN ('ready', 'out_for_delivery') THEN
      SELECT COALESCE((value #>> '{}')::boolean, false) INTO v_sms FROM public.payment_settings WHERE key = 'sms_enabled';
      SELECT p.phone INTO v_phone FROM public.profiles p WHERE p.id = v_order.user_id;
      IF COALESCE(v_sms, false) AND v_phone IS NOT NULL THEN
        PERFORM public.notification_enqueue('sms', v_template, v_phone, v_order.user_id, 'transactional', v_data,
                                            'order:' || NEW.id::text || ':sms');
      END IF;
    END IF;
    IF NEW.to_status = 'awaiting_payment' THEN
      PERFORM public.notification_enqueue_staff('staff_new_order', v_data, 'order:' || NEW.id::text || ':staff');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Notifications are best-effort: they must never block or roll back an order.
    RAISE WARNING 'order notification skipped: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_status_history_notify AFTER INSERT ON public.order_status_history
  FOR EACH ROW EXECUTE FUNCTION public._notify_order_status();

-- ---------------------------------------------------------------------------
-- Closing the bypass: an unpaid order is confirmed by a verified payment, not by a status change.
-- ---------------------------------------------------------------------------

@@TRANSITION_ORDER_STATUS@@

-- ---------------------------------------------------------------------------
-- Checkout accepts eft / card / paypal (provider availability is enforced by the server)
-- ---------------------------------------------------------------------------

@@CHECKOUT_PLACE_ORDER@@

-- ---------------------------------------------------------------------------
-- Privileges: tables are server-owned; members may read only their own payment status
-- ---------------------------------------------------------------------------

ALTER TABLE public.payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.payment_settings, public.fx_rates, public.payment_transactions, public.webhook_events,
  public.webhook_rejections, public.notification_events FROM anon, authenticated;
GRANT ALL ON public.payment_settings, public.fx_rates, public.payment_transactions, public.webhook_events,
  public.webhook_rejections, public.notification_events TO service_role;
GRANT USAGE ON SEQUENCE public.webhook_rejections_id_seq TO service_role;

GRANT SELECT (id, order_id, provider, status, expected_amount, expected_currency, fx_rate, created_at,
              completed_at, expires_at)
  ON public.payment_transactions TO authenticated;
CREATE POLICY "own payment transactions" ON public.payment_transactions FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY['fx_set_rate', 'fx_current_rate', 'webhook_reject', 'notification_enqueue',
        'notification_enqueue_staff', 'notification_claim', 'notification_complete', 'payment_initiate',
        'payment_attach_session', 'payment_mark_failed', 'payments_expire_stale', 'payments_apply_verified_event',
        '_eft_threshold', '_eft_settle', 'eft_submit', 'eft_approve', 'eft_reject', '_notify_order_status',
        '_webhook_events_guard', 'transition_order_status', 'checkout_place_order'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END
$$;
