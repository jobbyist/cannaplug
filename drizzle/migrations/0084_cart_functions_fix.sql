-- 27 Nov 2026: two fixes to the saved-basket functions, found in the review of PR #122.
--   * cart_save: two devices saving a brand-new basket at the same moment no longer lose the second one (later write wins).
--   * cart_unsubscribe: a link that matches no member now fails ("That link did not work") instead of saying "unsubscribed";
--     a link used twice still says "unsubscribed".
--   Rollback: supabase/rollbacks/20261127008000_cart_functions_fix_rollback.sql (puts the two functions back as they were).

CREATE OR REPLACE FUNCTION public.cart_save(p_user_id uuid, p_items jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_items jsonb;
  v_old public.member_carts;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'cart_invalid: user required'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'cart_invalid: items must be a list of at most 50 lines';
  END IF;
  -- One line per product, quantities clamped to 1..999; anything that is not a product id and a whole quantity is refused.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', pid, 'quantity', LEAST(q, 999)) ORDER BY pid), '[]'::jsonb)
  INTO v_items
  FROM (SELECT (e->>'product_id')::uuid AS pid, sum(GREATEST((e->>'quantity')::integer, 1)) AS q
        FROM jsonb_array_elements(p_items) e GROUP BY 1) s;

  SELECT * INTO v_old FROM public.member_carts WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Two devices saving for the first time at once: the later write wins instead of being dropped.
    INSERT INTO public.member_carts (user_id, items) VALUES (p_user_id, v_items)
    ON CONFLICT (user_id) DO UPDATE SET items = EXCLUDED.items, updated_at = now();
    RETURN;
  END IF;
  IF v_old.items = v_items THEN RETURN; END IF;  -- nothing changed: the idle clock keeps running
  UPDATE public.member_carts
  SET items = v_items, updated_at = now(),
      -- A fresh basket starts a new reminder cycle only if the last cart email was 3+ days ago.
      reminder_1_at = CASE WHEN v_old.items = '[]'::jsonb AND v_items <> '[]'::jsonb
                            AND COALESCE(v_old.reminder_2_at, v_old.reminder_1_at, '-infinity') < now() - interval '3 days'
                           THEN NULL ELSE v_old.reminder_1_at END,
      reminder_2_at = CASE WHEN v_old.items = '[]'::jsonb AND v_items <> '[]'::jsonb
                            AND COALESCE(v_old.reminder_2_at, v_old.reminder_1_at, '-infinity') < now() - interval '3 days'
                           THEN NULL ELSE v_old.reminder_2_at END
  WHERE user_id = p_user_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cart_unsubscribe(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{48}$' THEN RAISE EXCEPTION 'invalid_token'; END IF;
  UPDATE public.member_carts SET unsubscribed_at = now() WHERE unsubscribe_token = p_token AND unsubscribed_at IS NULL;
  -- A link that matches no member is an error; a link used twice still says "unsubscribed".
  IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM public.member_carts WHERE unsubscribe_token = p_token) THEN
    RAISE EXCEPTION 'invalid_token';
  END IF;
  RETURN jsonb_build_object('status', 'unsubscribed');
END;
$$;

