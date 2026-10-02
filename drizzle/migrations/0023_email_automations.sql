-- Milestone 6: email automations. Everything here only ENQUEUES rows in notification_events (deduplicated); the
-- cron dispatcher sends them. A failure to enqueue never blocks the underlying action.
--
--   triggers   member_welcome (new profile) · id_submitted + staff_id_review · id_approved · id_rejected
--   scheduled  email_automations_run(): back-in-stock · ID expiring (30 days) · staff low-stock digest (daily) ·
--              Journal digest (weekly, consenting subscribers only)

CREATE OR REPLACE FUNCTION public._notify_member_welcome()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_email text;
BEGIN
  BEGIN
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = NEW.id;
    IF v_email IS NOT NULL THEN
      PERFORM public.notification_enqueue('email', 'member_welcome', v_email, NEW.id, 'transactional',
        jsonb_build_object('contact_name', NEW.full_name), 'welcome:' || NEW.id::text);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'welcome email skipped: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER profiles_welcome_email AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public._notify_member_welcome();

CREATE OR REPLACE FUNCTION public._notify_id_verification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_email text;
  v_name text;
  v_template text;
  v_stamp text;
  v_data jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  BEGIN
    v_template := CASE NEW.status WHEN 'pending' THEN 'id_submitted' WHEN 'verified' THEN 'id_approved'
                                  WHEN 'rejected' THEN 'id_rejected' ELSE NULL END;
    IF v_template IS NULL THEN RETURN NEW; END IF;
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = NEW.user_id;
    SELECT p.full_name INTO v_name FROM public.profiles p WHERE p.id = NEW.user_id;
    v_stamp := extract(epoch FROM COALESCE(NEW.reviewed_at, NEW.submitted_at, now()))::bigint::text;
    v_data := jsonb_build_object('contact_name', v_name, 'rejection_code', NEW.rejection_code,
                                 'document_expires_on', NEW.document_expires_on);
    IF v_email IS NOT NULL THEN
      PERFORM public.notification_enqueue('email', v_template, v_email, NEW.user_id, 'transactional', v_data,
        'idv:' || NEW.user_id::text || ':' || NEW.status || ':' || v_stamp);
    END IF;
    IF NEW.status = 'pending' THEN
      PERFORM public.notification_enqueue_staff('staff_id_review', jsonb_build_object('member_name', v_name),
        'idvstaff:' || NEW.user_id::text || ':' || v_stamp);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'id verification email skipped: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_verification_email AFTER INSERT OR UPDATE ON public.customer_verification
  FOR EACH ROW EXECUTE FUNCTION public._notify_id_verification();

-- Scheduled automations. Safe to call as often as you like: every enqueue is deduplicated.
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
  FROM (SELECT p.name, public._product_available(p.id) AS available
        FROM public.products p WHERE p.is_active) s
  WHERE available <= 5;
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

REVOKE ALL ON FUNCTION public._notify_member_welcome(), public._notify_id_verification(), public.email_automations_run(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_automations_run(timestamptz) TO service_role;
