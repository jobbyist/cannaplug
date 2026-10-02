#!/usr/bin/env python3
"""Builds supabase/migrations/20261003001000_payments_notifications.sql (+ drizzle mirror) from the template,
lifting the CURRENT text of transition_order_status and checkout_place_order so they cannot drift."""
import re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
mig = root / "supabase/migrations"

def lift(path, name):
    src = (mig / path).read_text()
    ms = list(re.finditer(r"CREATE OR REPLACE FUNCTION public\." + re.escape(name) + r"\(.*?\n\$\$;\n", src, re.S))
    assert ms, f"{name} not found in {path}"
    return ms[-1].group(0)

transition = lift("20260929010000_pos_atomic_inventory.sql", "transition_order_status")
guard = """  IF p_to_status = 'confirmed' AND v_order.status = 'awaiting_payment' THEN
    RAISE EXCEPTION 'payment_confirmation_required: an unpaid order is confirmed by a verified payment (provider webhook or the EFT verification workflow), not by a status change';
  END IF;

  IF p_to_status = 'confirmed' AND v_order.status = 'awaiting_payment' THEN"""
old = "  IF p_to_status = 'confirmed' AND v_order.status = 'awaiting_payment' THEN"
assert old in transition
transition = transition.replace(old, guard, 1)

checkout = lift("20260930003000_id_verification.sql", "checkout_place_order")
old_pay = """  IF p_payment_method IS DISTINCT FROM 'eft' THEN
    RAISE EXCEPTION 'payment_method_unsupported: only EFT is available right now';
  END IF;"""
assert old_pay in checkout
checkout = checkout.replace(old_pay, """  IF p_payment_method IS NULL OR p_payment_method NOT IN ('eft', 'card', 'paypal') THEN
    RAISE EXCEPTION 'payment_method_unsupported: choose EFT, card or PayPal';
  END IF;""", 1)

out = (root / "scripts/m5-migration.template.sql").read_text()
out = out.replace("@@TRANSITION_ORDER_STATUS@@", transition).replace("@@CHECKOUT_PLACE_ORDER@@", checkout)
name = "20261003001000_payments_notifications.sql"
(mig / name).write_text(out)
(root / "drizzle/migrations/0018_payments_notifications.sql").write_text(out)
print(name, len(out))

# --- rollback: restore the two lifted functions exactly as they were before this migration -----------------
orig_transition = lift("20260929010000_pos_atomic_inventory.sql", "transition_order_status")
orig_checkout = lift("20260930003000_id_verification.sql", "checkout_place_order")
funcs = re.findall(r"CREATE OR REPLACE FUNCTION public\.(\w+)\(", (root / "scripts/m5-migration.template.sql").read_text())
new_funcs = sorted(set(funcs) - {"transition_order_status", "checkout_place_order"})
sigs = {
    "fx_set_rate": "uuid, text, text, numeric, integer, text", "fx_record_live_rate": "text, text, numeric, integer, text",
    "fx_current_rate": "text, text", "webhook_reject": "text, text, text, text",
    "notification_enqueue": "text, text, text, uuid, text, jsonb, text, integer",
    "notification_enqueue_staff": "text, jsonb, text, public.app_role", "notification_claim": "integer, integer",
    "notification_complete": "uuid, boolean, text, text, boolean", "payment_initiate": "uuid, uuid, text, text, text, text",
    "payment_attach_session": "uuid, text, text", "payment_mark_failed": "uuid, text", "payments_expire_stale": "",
    "payments_apply_verified_event": "text, text, text, jsonb, jsonb", "_eft_threshold": "", "_eft_settle": None,
    "eft_submit": "uuid, uuid, text, numeric, date, text, text", "eft_approve": "uuid, uuid, text",
    "eft_reject": "uuid, uuid, text", "_notify_order_status": "", "_webhook_events_guard": "",
}
drops = "\n".join(f"DROP FUNCTION IF EXISTS public.{f}({sigs[f]});" for f in new_funcs if sigs.get(f) is not None)
rb = f"""-- Rollback for {name}.
-- Restores the pre-Milestone-5 definitions of transition_order_status / checkout_place_order (the latter is
-- EFT-only again), removes the payment/notification functions, triggers and tables.
-- WARNING: this DROPS payment_transactions, webhook_events, webhook_rejections, fx_rates, payment_settings and
-- notification_events with all their rows. Orders already confirmed by a payment stay confirmed, but the
-- provider-side audit trail is lost, so EXPORT those tables first if the release has taken real payments.

BEGIN;

DROP TRIGGER IF EXISTS order_status_history_notify ON public.order_status_history;

{orig_transition}
{orig_checkout}
-- _eft_settle takes the payment_transactions row type, so it must go before the table does.
DROP FUNCTION IF EXISTS public._eft_settle(public.payment_transactions, uuid);

DROP TABLE IF EXISTS public.notification_events, public.webhook_rejections, public.webhook_events,
  public.payment_transactions, public.fx_rates, public.payment_settings CASCADE;

{drops}

COMMIT;
"""
(root / "supabase/rollbacks" / name.replace(".sql", "_rollback.sql")).write_text(rb)
print("rollback written")
