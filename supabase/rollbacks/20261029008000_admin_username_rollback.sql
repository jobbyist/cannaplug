-- Rollback for 20261029008000_admin_username: removes the admin username tool and puts back the previous
-- admin_customers_page (no username column or search). Usernames an admin already changed are kept.
DROP FUNCTION IF EXISTS public.admin_set_username(uuid, uuid, text, text, text);
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
      SELECT ur.user_id, ur.created_at AS member_since, p.full_name, p.phone, u.email
      FROM public.user_roles ur
      JOIN auth.users u ON u.id = ur.user_id
      LEFT JOIN public.profiles p ON p.id = ur.user_id
      WHERE ur.role = 'customer'
        AND NOT EXISTS (SELECT 1 FROM public.user_roles s
                        WHERE s.user_id = ur.user_id AND s.role IN ('budtender', 'manager', 'admin'))
        AND (v_pat IS NULL OR p.full_name ILIKE v_pat OR p.phone ILIKE v_pat OR u.email ILIKE v_pat)
    ), page AS (
      SELECT * FROM base ORDER BY member_since DESC, user_id LIMIT v_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM base),
      'rows', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', g.user_id, 'full_name', g.full_name, 'phone', g.phone, 'email', g.email,
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
