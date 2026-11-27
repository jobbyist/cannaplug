-- Cannaplug: apply 20261127003000_billing_due_email to the hosted project (khltynzzcjhlujxbgyod).
-- Runs as one transaction: everything applies, or nothing does. Paste all of it into the Supabase SQL Editor and click Run.
-- The migration file is included unchanged.
BEGIN;

-- ===== 20261127003000_billing_due_email =====
-- 27 Nov 2026: email the managers and admins a day before a service bill is due.
--   Until now the day-before reminder only reached the admin bell (team_notifications). billing_due_alerts_refresh() now also
--   queues one email per manager/admin (the same audience as the daily sales email) the first time a bill is due tomorrow (SAST).
--   * Template: staff_billing_due. It names the service, provider, amount and due date, shows the next bill after this one, and
--     tells the reader to contact the webmaster for billing help so the service is not disrupted.
--   * One email per person per bill per due date: the dedupe key is billing_due:<slug>:<due date>, so the 10-minute refresh never
--     re-sends, and the next cycle's bill (a new due date) sends again.
--   * Only active accounts send. Paused, cancelled and pending accounts raise nothing, as with the bell alert.
--   * The bell alert is unchanged. No personal data is in the email (service name, provider, amount text, dates).
-- Applies to bills that fall due from tomorrow; a bill already due today is not back-filled.

CREATE OR REPLACE FUNCTION public.billing_due_alerts_refresh()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_due date;
  v_next date;
  v_cand date;
  v_next_acc public.billing_accounts;
  r public.billing_accounts;
  a public.billing_accounts;
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

    IF r.status = 'active' AND v_due = v_today + 1 THEN
      -- The next bill after this one: the earliest due date, from the day after this due date, among the active accounts
      -- (this account's own next cycle counts).
      v_next := NULL;
      v_next_acc := NULL;
      FOR a IN SELECT * FROM public.billing_accounts
                WHERE recur_kind IS NOT NULL AND status = 'active' ORDER BY position LOOP
        v_cand := public.billing_next_due(a.recur_kind, a.recur_n, a.anchor_date, v_due + 1);
        IF v_cand IS NOT NULL AND (v_next IS NULL OR v_cand < v_next) THEN
          v_next := v_cand;
          v_next_acc := a;
        END IF;
      END LOOP;
      PERFORM public.notification_enqueue_staff(
        'staff_billing_due',
        jsonb_strip_nulls(jsonb_build_object(
          'account', r.name,
          'provider', r.provider,
          'amount_text', NULLIF(r.amount_text, ''),
          'due_on', trim(to_char(v_due, 'FMDay, FMDD FMMonth YYYY')),
          'next_account', v_next_acc.name,
          'next_provider', v_next_acc.provider,
          'next_amount_text', NULLIF(v_next_acc.amount_text, ''),
          'next_due_on', CASE WHEN v_next IS NULL THEN NULL
                              ELSE trim(to_char(v_next, 'FMDay, FMDD FMMonth YYYY')) END)),
        'billing_due:' || r.slug || ':' || v_due::text,
        'manager'::public.app_role);
    END IF;
  END LOOP;
  RETURN v_n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.billing_due_alerts_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_due_alerts_refresh() TO service_role;

COMMIT;
