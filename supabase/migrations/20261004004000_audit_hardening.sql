-- Milestone 6: structured audit events for admin, manager and POS actions.
--
--   * audit_log becomes tamper-evident: rows can never be updated, deleted or truncated (even by the service role).
--   * Row triggers capture the actions that used to rely on application code remembering to log them:
--       - pos_sale_completed      (every till sale, actor = cashier)
--       - order_status_changed    (every order transition, actor = staff member or member)
--       - role_granted / role_revoked / role_changed   (any user_roles write, actor = the signed-in admin when known)
--       - id_verification_decided (approve / reject, actor = reviewer)
--   * Query indexes for the admin audit viewer.
-- The functions are best-effort wrappers: an audit failure never blocks a till sale or an order.

CREATE OR REPLACE FUNCTION public._audit_log_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public._audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public._audit_log_immutable();

CREATE INDEX IF NOT EXISTS audit_log_created_idx ON public.audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON public.audit_log (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON public.audit_log (action, created_at DESC);

CREATE OR REPLACE FUNCTION public._audit_pos_sale()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  BEGIN
    PERFORM public._audit(NEW.cashier_id, 'pos_sale_completed', 'pos_sale', NEW.id,
      jsonb_build_object('receipt', NEW.receipt_number, 'total', NEW.total, 'session_id', NEW.session_id,
                         'customer_id', NEW.customer_id));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pos sale audit skipped: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pos_sales_audit AFTER INSERT ON public.pos_sales
  FOR EACH ROW EXECUTE FUNCTION public._audit_pos_sale();

CREATE OR REPLACE FUNCTION public._audit_order_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  BEGIN
    PERFORM public._audit(NEW.actor_user_id, 'order_status_changed', 'order', NEW.order_id,
      jsonb_build_object('from', NEW.from_status, 'to', NEW.to_status));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'order status audit skipped: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_status_history_audit AFTER INSERT ON public.order_status_history
  FOR EACH ROW EXECUTE FUNCTION public._audit_order_status();

CREATE OR REPLACE FUNCTION public._audit_user_roles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  -- Role changes are the most sensitive writes in the system: this one is NOT best-effort.
  IF TG_OP = 'INSERT' THEN
    PERFORM public._audit(v_actor, 'role_granted', 'user_role', NULL,
      jsonb_build_object('user_id', NEW.user_id, 'role', NEW.role));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM public._audit(v_actor, 'role_changed', 'user_role', NULL,
      jsonb_build_object('user_id', NEW.user_id, 'from', OLD.role, 'to', NEW.role));
    RETURN NEW;
  ELSE
    PERFORM public._audit(v_actor, 'role_revoked', 'user_role', NULL,
      jsonb_build_object('user_id', OLD.user_id, 'role', OLD.role));
    RETURN OLD;
  END IF;
END;
$$;
CREATE TRIGGER user_roles_audit AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public._audit_user_roles();

CREATE OR REPLACE FUNCTION public._audit_id_verification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('verified', 'rejected') THEN
    BEGIN
      PERFORM public._audit(NEW.reviewed_by, 'id_verification_decided', 'customer_verification', NULL,
        jsonb_build_object('member_id', NEW.user_id, 'decision', NEW.status, 'rejection_code', NEW.rejection_code));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'id verification audit skipped: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_verification_audit AFTER UPDATE ON public.customer_verification
  FOR EACH ROW EXECUTE FUNCTION public._audit_id_verification();

REVOKE ALL ON FUNCTION public._audit_log_immutable(), public._audit_pos_sale(), public._audit_order_status(),
  public._audit_user_roles(), public._audit_id_verification() FROM PUBLIC, anon, authenticated;
