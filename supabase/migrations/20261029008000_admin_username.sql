-- 29 Oct 2026: managers and admins can change a member's username from the Customers tab.
--   * admin_set_username(actor, member, username, reason, key): manager or admin only; the member must not be staff
--     (staff change their own once, from the portal); the new name must be free, valid and not reserved; a reason of
--     3-200 characters is required and is audited with the old and the new name. The result is final for the member
--     (username_auto = false), and any link that used the old name stops working.
--   * admin_customers_page now returns each member's username and searches by it.
-- No DROP and no DELETE in this file.

CREATE OR REPLACE FUNCTION public.admin_set_username(
  p_actor uuid, p_user_id uuid, p_username text, p_reason text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_cached jsonb;
  v text := lower(btrim(COALESCE(p_username, '')));
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_current text;
  v_status text;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('admin_username', p_actor, p_idempotency_key,
    jsonb_build_object('u', v, 'm', p_user_id, 'r', v_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF length(v_reason) NOT BETWEEN 3 AND 200 THEN
    RAISE EXCEPTION 'reason_required: give a reason of 3-200 characters';
  END IF;
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF public._is_staff(p_user_id) THEN
    RAISE EXCEPTION 'forbidden: a staff member changes their own username from their account' USING ERRCODE = '42501';
  END IF;
  SELECT p.username INTO v_current FROM public.profiles p WHERE p.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
  IF v_current IS NOT DISTINCT FROM v THEN RAISE EXCEPTION 'username_unchanged: that is already their username'; END IF;
  v_status := public.username_check(v);
  IF v_status <> 'ok' THEN RAISE EXCEPTION 'username_%: %', v_status, v; END IF;
  BEGIN
    UPDATE public.profiles SET username = v, username_auto = false, updated_at = now() WHERE id = p_user_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'username_taken: %', v;
  END;
  PERFORM public._audit(p_actor, 'admin_username_changed', 'profile', p_user_id,
    jsonb_build_object('previous', v_current, 'username', v, 'reason', v_reason));
  v_response := jsonb_build_object('username', v, 'previous', v_current);
  RETURN public._idem_finish('admin_username', p_actor, p_idempotency_key, v_response);
END;
$fn$;
REVOKE ALL ON FUNCTION public.admin_set_username(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_username(uuid, uuid, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_customers_page(p_actor uuid, p_search text, p_limit integer, p_offset integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
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
      SELECT ur.user_id, ur.created_at AS member_since, p.full_name, p.phone, u.email, p.username
      FROM public.user_roles ur
      JOIN auth.users u ON u.id = ur.user_id
      LEFT JOIN public.profiles p ON p.id = ur.user_id
      WHERE ur.role = 'customer'
        AND NOT EXISTS (SELECT 1 FROM public.user_roles s
                        WHERE s.user_id = ur.user_id AND s.role IN ('budtender', 'manager', 'admin'))
        AND (v_pat IS NULL OR p.full_name ILIKE v_pat OR p.phone ILIKE v_pat OR u.email ILIKE v_pat OR p.username ILIKE v_pat)
    ), page AS (
      SELECT * FROM base ORDER BY member_since DESC, user_id LIMIT v_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM base),
      'rows', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', g.user_id, 'full_name', g.full_name, 'phone', g.phone, 'email', g.email, 'username', g.username,
          'member_since', g.member_since, 'order_count', COALESCE(o.n, 0), 'spend_rand', COALESCE(o.total, 0))
          ORDER BY g.member_since DESC, g.user_id)
        FROM page g
        LEFT JOIN LATERAL (
          SELECT count(*) AS n, sum(x.total_rand) AS total FROM public.orders x
          WHERE x.user_id = g.user_id
            AND x.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')) o ON true), '[]'::jsonb)));
END;
$fn$;
REVOKE ALL ON FUNCTION public.admin_customers_page(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_customers_page(uuid, text, integer, integer) TO service_role;
