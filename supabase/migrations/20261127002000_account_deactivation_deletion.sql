-- 27 Nov 2026: customers can deactivate or delete their own account (staff request: a member asked for deletion).
--
--   Deactivate (temporary): the member keeps everything but cannot place orders and gets no marketing email. They sign in and
--   press "Reactivate" to come back. Their points and order history are untouched.
--   Delete (permanent): the member asks; the account is deactivated at once and shows at the top of Admin -> Customers as
--   "Deletion requested". An admin completes it there (or deletes a member who asked outside the app, with a written reason).
--   Completing it ANONYMISES the member instead of dropping rows, because some records must be kept:
--     removed or blanked: name, phone, date of birth, address, username, saved addresses, wishlist and stock alerts, ID number
--       and ID check (the ID photos are removed from storage by the server), newsletter address, comments (hidden), the delivery
--       address, phone and notes on past orders, emailed-receipt addresses, queued email addresses and their data.
--     kept: orders, till sales and receipts (tax and stock records, now showing "Deleted member"), the loyalty ledger, referral
--       rows, the audit log, and any clinical documents (retention rules; the policy table says nothing may be purged until the
--       owner's counsel confirms periods). Kept rows no longer identify the person: the sign-in email is replaced and the login is
--       blocked by the server function.
--   Refused while the member has an order in progress, and for staff accounts.
--
--   New columns on profiles are not covered by the members' column grants, so a member cannot edit them from the browser.
--   Every function: SECURITY DEFINER, search_path '', explicit actor, idempotency key, audit row (no personal data in it),
--   service role only. Also here: placing an order is refused for a deactivated or deleted member, and the Customers list shows
--   each member's account status and puts "Deletion requested" first.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
COMMENT ON COLUMN public.profiles.deactivated_at IS 'Set while the member has deactivated (or asked to delete) the account. Cleared by reactivating.';
COMMENT ON COLUMN public.profiles.deletion_requested_at IS 'Set when the member asked for the account to be deleted; an admin completes it.';
COMMENT ON COLUMN public.profiles.deleted_at IS 'Set when the account was anonymised (admin_account_delete). Final.';

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Orders are refused for a deactivated or deleted member (the one place every order passes through)
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._require_verified_member(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF public._is_staff(p_user_id) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles p
             WHERE p.id = p_user_id AND (p.deactivated_at IS NOT NULL OR p.deleted_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'account_deactivated: your account is deactivated. Reactivate it in Account settings to place orders';
  END IF;
  SELECT cv.status INTO v_status FROM public.customer_verification cv WHERE cv.user_id = p_user_id;
  IF v_status = 'rejected' THEN
    RAISE EXCEPTION 'verification_rejected: your ID could not be approved. Upload a new one to keep ordering';
  END IF;
  -- Every other state (none, pending, provisional, expired, verified) may order: the ID is checked at collection.
END;
$$;
REVOKE ALL ON FUNCTION public._require_verified_member(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._require_verified_member(uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The member's own choices: deactivate, reactivate, ask for deletion
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._member_open_orders(p_user uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::integer FROM public.orders o
  WHERE o.user_id = p_user AND o.status NOT IN ('completed', 'cancelled')
$$;
REVOKE ALL ON FUNCTION public._member_open_orders(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._member_open_orders(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.member_account_state(p_user uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'status', CASE WHEN p.deleted_at IS NOT NULL THEN 'deleted'
                   WHEN p.deletion_requested_at IS NOT NULL THEN 'deletion_requested'
                   WHEN p.deactivated_at IS NOT NULL THEN 'deactivated'
                   ELSE 'active' END,
    'deactivated_at', p.deactivated_at,
    'deletion_requested_at', p.deletion_requested_at,
    'open_orders', public._member_open_orders(p_user))
  FROM public.profiles p WHERE p.id = p_user
$$;
REVOKE ALL ON FUNCTION public.member_account_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.member_account_state(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.member_account_set_status(
  p_user uuid,
  p_action text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_profile record;
  v_email text;
  v_result jsonb;
BEGIN
  IF p_action NOT IN ('deactivate', 'reactivate', 'request_deletion') THEN
    RAISE EXCEPTION 'invalid_input: unknown action';
  END IF;
  v_cached := public._idem_begin('member_account_set_status', p_user, p_idempotency_key,
    jsonb_build_object('a', p_action));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF public._is_staff(p_user) THEN
    RAISE EXCEPTION 'staff_account: staff accounts are managed by an admin, not from the member page';
  END IF;
  SELECT id, deactivated_at, deletion_requested_at, deleted_at INTO v_profile
  FROM public.profiles WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;
  IF v_profile.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'account_deleted: this account has been deleted'; END IF;

  IF p_action = 'reactivate' THEN
    UPDATE public.profiles SET deactivated_at = NULL, deletion_requested_at = NULL WHERE id = p_user;
  ELSE
    IF public._member_open_orders(p_user) > 0 THEN
      RAISE EXCEPTION 'open_orders: finish or cancel your open orders before closing your account';
    END IF;
    UPDATE public.profiles
       SET deactivated_at = COALESCE(deactivated_at, now()),
           deletion_requested_at = CASE WHEN p_action = 'request_deletion'
                                        THEN COALESCE(deletion_requested_at, now()) ELSE deletion_requested_at END
     WHERE id = p_user;
    -- No marketing to a member who has closed their account. Order and account emails are unaffected.
    SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = p_user;
    UPDATE public.newsletter_subscribers SET unsubscribed_at = now()
     WHERE lower(email) = v_email AND unsubscribed_at IS NULL;
  END IF;

  v_result := public.member_account_state(p_user);
  PERFORM public._audit(p_user,
    CASE p_action WHEN 'deactivate' THEN 'member_account_deactivated'
                  WHEN 'reactivate' THEN 'member_account_reactivated'
                  ELSE 'member_account_deletion_requested' END,
    'member', p_user, '{}'::jsonb);
  RETURN public._idem_finish('member_account_set_status', p_user, p_idempotency_key, v_result);
END;
$$;
REVOKE ALL ON FUNCTION public.member_account_set_status(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.member_account_set_status(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. An admin completes a deletion (anonymises the member)
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_account_delete(
  p_actor uuid,
  p_user uuid,
  p_reason text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_profile record;
  v_email text;
  v_tag text := replace(p_user::text, '-', '');
  v_doc_paths text[];
  v_placeholder text := 'deleted-' || replace(p_user::text, '-', '') || '@deleted.invalid';
  v_orders integer;
  v_medical integer;
  v_result jsonb;
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin');
  IF length(v_reason) < 3 OR length(v_reason) > 200 THEN
    RAISE EXCEPTION 'invalid_input: give a reason of 3 to 200 characters (for example: asked by WhatsApp on 27 Nov)';
  END IF;
  v_cached := public._idem_begin('admin_account_delete', p_actor, p_idempotency_key,
    jsonb_build_object('u', p_user, 'r', v_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_actor = p_user THEN RAISE EXCEPTION 'invalid_input: you cannot delete your own account here'; END IF;
  IF public._is_staff(p_user) THEN
    RAISE EXCEPTION 'staff_account: remove the staff role first, then delete the member account';
  END IF;
  SELECT id, deleted_at INTO v_profile FROM public.profiles WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;
  IF v_profile.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'account_deleted: this account is already deleted'; END IF;
  IF public._member_open_orders(p_user) > 0 THEN
    RAISE EXCEPTION 'open_orders: the member has an order in progress. Complete or cancel it first';
  END IF;

  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = p_user;
  SELECT COALESCE(array_agg(document_path) FILTER (WHERE document_path IS NOT NULL), '{}') INTO v_doc_paths
  FROM public.customer_verification WHERE user_id = p_user;
  SELECT count(*)::integer INTO v_orders FROM public.orders WHERE user_id = p_user;
  SELECT count(*)::integer INTO v_medical FROM public.medical_documents WHERE member_id = p_user;

  -- Personal data that is removed outright.
  DELETE FROM public.addresses WHERE user_id = p_user;
  DELETE FROM public.wishlist_items WHERE user_id = p_user;
  DELETE FROM public.back_in_stock_subscriptions WHERE user_id = p_user;
  DELETE FROM public.member_feature_seen WHERE user_id = p_user;
  DELETE FROM public.member_signup_details WHERE user_id = p_user;
  DELETE FROM public.customer_verification WHERE user_id = p_user;
  UPDATE public.article_comments
     SET hidden_at = COALESCE(hidden_at, now()), hide_reason = COALESCE(hide_reason, 'account deleted'),
         display_name = 'Deleted member'
   WHERE user_id = p_user;

  -- Kept records stop identifying the person.
  UPDATE public.orders
     SET delivery_address = CASE WHEN delivery_address IS NULL THEN NULL ELSE jsonb_build_object('removed', true) END,
         contact_phone = NULL, notes = NULL
   WHERE user_id = p_user;
  IF v_email IS NOT NULL THEN
    UPDATE public.pos_receipt_sends SET email = v_placeholder WHERE lower(email) = v_email;
    UPDATE public.newsletter_subscribers
       SET email = v_placeholder, unsubscribed_at = COALESCE(unsubscribed_at, now()), ip_hash = NULL
     WHERE lower(email) = v_email;
  END IF;
  UPDATE public.notification_events SET recipient = v_placeholder, data = '{}'::jsonb
   WHERE recipient_user_id = p_user;
  UPDATE public.imported_customers
     SET email = v_placeholder, first_name = 'Deleted', last_name = 'Member', phone = NULL,
         username = 'deleted_' || left(v_tag, 20)
   WHERE user_id = p_user;
  UPDATE public.profiles
     SET full_name = 'Deleted member', first_name = NULL, last_name = NULL, phone = NULL, date_of_birth = NULL,
         address = NULL, username = NULL, deactivated_at = COALESCE(deactivated_at, now()), deleted_at = now()
   WHERE id = p_user;

  v_result := jsonb_build_object(
    'user_id', p_user,
    'email_placeholder', v_placeholder,
    'id_document_paths', to_jsonb(v_doc_paths),
    'kept', jsonb_build_object('orders', v_orders, 'medical_documents', v_medical));
  -- No name, email or phone in the audit row.
  PERFORM public._audit(p_actor, 'member_account_deleted', 'member', p_user,
    jsonb_build_object('reason', v_reason, 'orders_kept', v_orders, 'medical_documents_kept', v_medical));
  RETURN public._idem_finish('admin_account_delete', p_actor, p_idempotency_key, v_result);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_account_delete(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_account_delete(uuid, uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Customers list: account status, deletion requests first, deleted members hidden
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_customers_page(p_actor uuid, p_search text, p_limit integer, p_offset integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_q text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_pat text;
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  IF v_q IS NOT NULL AND length(v_q) > 100 THEN RAISE EXCEPTION 'invalid_input: search is too long'; END IF;
  v_pat := CASE WHEN v_q IS NULL THEN NULL
                ELSE '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' END;

  RETURN (
    WITH base AS (
      SELECT ur.user_id, ur.created_at AS member_since, p.full_name, p.phone, u.email, p.username,
             (p.deletion_requested_at IS NOT NULL) AS requested,
             CASE WHEN p.deletion_requested_at IS NOT NULL THEN 'deletion_requested'
                  WHEN p.deactivated_at IS NOT NULL THEN 'deactivated'
                  ELSE 'active' END AS account_status
      FROM public.user_roles ur
      JOIN auth.users u ON u.id = ur.user_id
      LEFT JOIN public.profiles p ON p.id = ur.user_id
      WHERE ur.role = 'customer'
        AND p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.user_roles s
                        WHERE s.user_id = ur.user_id AND s.role IN ('budtender', 'manager', 'admin'))
        AND (v_pat IS NULL OR p.full_name ILIKE v_pat OR p.phone ILIKE v_pat OR u.email ILIKE v_pat OR p.username ILIKE v_pat)
    ), page AS (
      SELECT * FROM base ORDER BY requested DESC, member_since DESC, user_id LIMIT v_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM base),
      'rows', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', g.user_id, 'full_name', g.full_name, 'phone', g.phone, 'email', g.email, 'username', g.username,
          'member_since', g.member_since, 'order_count', COALESCE(o.n, 0), 'spend_rand', COALESCE(o.total, 0),
          'account_status', g.account_status)
          ORDER BY g.requested DESC, g.member_since DESC, g.user_id)
        FROM page g
        LEFT JOIN LATERAL (
          SELECT count(*) AS n, sum(x.total_rand) AS total FROM public.orders x
          WHERE x.user_id = g.user_id
            AND x.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')) o ON true), '[]'::jsonb)));
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_customers_page(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_customers_page(uuid, text, integer, integer) TO service_role;
