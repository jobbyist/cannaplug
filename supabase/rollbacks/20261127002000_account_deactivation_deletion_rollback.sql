-- Rollback for 20261127002000_account_deactivation_deletion. Refused while any member has deactivated, asked for deletion or
-- been deleted: the three profile columns would be lost, and a deleted member's personal data is already gone for good.
-- Reactivate (clear) every deactivated member first, or accept that deleted members stay anonymised: this script does not
-- un-anonymise anyone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles
             WHERE deactivated_at IS NOT NULL OR deletion_requested_at IS NOT NULL OR deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'accounts are deactivated, awaiting deletion or deleted: clear them (and accept that deleted members stay anonymised) before rolling back';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.admin_account_delete(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.member_account_set_status(uuid, text, text);
DROP FUNCTION IF EXISTS public.member_account_state(uuid);
DROP FUNCTION IF EXISTS public._member_open_orders(uuid);

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
  SELECT cv.status INTO v_status FROM public.customer_verification cv WHERE cv.user_id = p_user_id;
  IF v_status = 'rejected' THEN
    RAISE EXCEPTION 'verification_rejected: your ID could not be approved. Upload a new one to keep ordering';
  END IF;
  -- Every other state (none, pending, provisional, expired, verified) may order: the ID is checked at collection.
END;
$$;
REVOKE ALL ON FUNCTION public._require_verified_member(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._require_verified_member(uuid) TO service_role;

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
$function$;
REVOKE ALL ON FUNCTION public.admin_customers_page(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_customers_page(uuid, text, integer, integer) TO service_role;

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS deactivated_at,
  DROP COLUMN IF EXISTS deletion_requested_at,
  DROP COLUMN IF EXISTS deleted_at;
