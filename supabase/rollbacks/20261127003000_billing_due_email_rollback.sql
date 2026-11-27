-- Rollback for 20261127003000_billing_due_email: restores the bell-only bill-due alert from 20261029002000.
-- Emails already queued or sent stay as they are (notification_events is append-only history).
CREATE OR REPLACE FUNCTION public.billing_due_alerts_refresh()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_due date;
  r public.billing_accounts;
  v_n integer := 0;
BEGIN
  FOR r IN SELECT * FROM public.billing_accounts WHERE recur_kind IS NOT NULL LOOP
    v_due := public.billing_next_due(r.recur_kind, r.recur_n, r.anchor_date, v_today);
    IF public._team_alert_sync(
         'alert:bill-due:' || r.slug,
         CASE WHEN r.status = 'active' AND v_due = v_today + 1 THEN 1 ELSE 0 END,
         'reminder', 'manager',
         left('Bill due tomorrow: ' || r.name, 120),
         left(r.provider || ': ' || COALESCE(NULLIF(r.amount_text, ''), 'payment') || ' is due on '
              || trim(to_char(COALESCE(v_due, v_today), 'FMDD FMMonth YYYY')) || '.', 1000)) THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.billing_due_alerts_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_due_alerts_refresh() TO service_role;
