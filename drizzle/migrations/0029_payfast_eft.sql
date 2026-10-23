-- Prompt 5 (23 Oct 2026): Cannaplug drops Yoco completely. Online card / Instant EFT payments move to PayFast (ZAR);
-- PayPal (USD at a live rate) is unchanged. Bank-transfer (EFT) details move out of the code into a manager-set
-- setting, so EFT is only offered once the owner has confirmed the account.
--
-- Refuses to run while any Yoco payment, webhook event or rejection exists: history is never rewritten.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.payment_transactions WHERE provider = 'yoco')
     OR EXISTS (SELECT 1 FROM public.webhook_events WHERE provider = 'yoco') THEN
    RAISE EXCEPTION 'yoco_history_present: settle or archive Yoco transactions before removing the provider';
  END IF;
END;
$$;

ALTER TABLE public.payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_provider_check;
ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_provider_check
  CHECK (provider IN ('paypal', 'payfast', 'eft'));
ALTER TABLE public.webhook_events DROP CONSTRAINT IF EXISTS webhook_events_provider_check;
ALTER TABLE public.webhook_events ADD CONSTRAINT webhook_events_provider_check
  CHECK (provider IN ('paypal', 'payfast'));

-- Same functions as 20261003001000, with PayFast in place of Yoco (PayFast, like Yoco, charges ZAR).
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
  IF p_provider IS NULL OR p_provider NOT IN ('paypal', 'payfast') THEN RAISE EXCEPTION 'invalid_provider'; END IF;
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

  IF p_provider = 'payfast' THEN
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
  IF p_provider IS NULL OR p_provider NOT IN ('paypal', 'payfast')
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
-- Bank transfer (EFT) details: shown to members only once a manager has entered and confirmed them.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.payment_set_eft_details(p_actor uuid, p_details jsonb, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_clean jsonb;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);
  v_cached := public._idem_begin('payment_set_eft_details', p_actor, p_idempotency_key,
    COALESCE(p_details, 'null'::jsonb));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  IF p_details IS NULL OR jsonb_typeof(p_details) = 'null' THEN
    -- Switching EFT off: members stop seeing the option immediately.
    INSERT INTO public.payment_settings (key, value, updated_by, updated_at)
    VALUES ('eft_bank_details', 'null'::jsonb, p_actor, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by,
                                    updated_at = EXCLUDED.updated_at;
    PERFORM public._audit(p_actor, 'eft_details_cleared', 'payment_settings', NULL, '{}'::jsonb);
    v_response := jsonb_build_object('enabled', false);
    RETURN public._idem_finish('payment_set_eft_details', p_actor, p_idempotency_key, v_response);
  END IF;

  IF jsonb_typeof(p_details) <> 'object' THEN RAISE EXCEPTION 'invalid_eft_details'; END IF;
  v_clean := jsonb_build_object(
    'bank', btrim(COALESCE(p_details->>'bank', '')),
    'account_holder', btrim(COALESCE(p_details->>'account_holder', '')),
    'account_type', NULLIF(btrim(COALESCE(p_details->>'account_type', '')), ''),
    'account_number', regexp_replace(COALESCE(p_details->>'account_number', ''), '\s', '', 'g'),
    'branch_code', regexp_replace(COALESCE(p_details->>'branch_code', ''), '\s', '', 'g'),
    'confirmed_by_owner', COALESCE((p_details->>'confirmed_by_owner')::boolean, false));
  IF length(v_clean->>'bank') NOT BETWEEN 2 AND 60 THEN RAISE EXCEPTION 'invalid_bank: 2-60 characters'; END IF;
  IF length(v_clean->>'account_holder') NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'invalid_account_holder: 2-100 characters';
  END IF;
  IF v_clean->>'account_type' IS NOT NULL AND length(v_clean->>'account_type') > 60 THEN
    RAISE EXCEPTION 'invalid_account_type: at most 60 characters';
  END IF;
  IF (v_clean->>'account_number') !~ '^[0-9]{6,16}$' THEN
    RAISE EXCEPTION 'invalid_account_number: 6-16 digits';
  END IF;
  IF (v_clean->>'branch_code') !~ '^[0-9]{6}$' THEN RAISE EXCEPTION 'invalid_branch_code: 6 digits'; END IF;
  IF NOT (v_clean->>'confirmed_by_owner')::boolean THEN
    RAISE EXCEPTION 'eft_details_unconfirmed: the owner must confirm these details before members see them';
  END IF;

  INSERT INTO public.payment_settings (key, value, updated_by, updated_at)
  VALUES ('eft_bank_details', v_clean || jsonb_build_object('confirmed_at', now()), p_actor, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by,
                                  updated_at = EXCLUDED.updated_at;
  -- The audit row records that the account changed and its last 4 digits, never the full number.
  PERFORM public._audit(p_actor, 'eft_details_set', 'payment_settings', NULL,
    jsonb_build_object('bank', v_clean->>'bank', 'account_last4', right(v_clean->>'account_number', 4)));
  v_response := jsonb_build_object('enabled', true);
  RETURN public._idem_finish('payment_set_eft_details', p_actor, p_idempotency_key, v_response);
END;
$$;

REVOKE ALL ON FUNCTION public.payment_set_eft_details(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payment_set_eft_details(uuid, jsonb, text) TO service_role;
