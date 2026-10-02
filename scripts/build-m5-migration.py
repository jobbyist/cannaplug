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
