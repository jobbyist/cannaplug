#!/usr/bin/env python3
"""Assembles the checkout migration + rollback.

Four Milestone 4 functions must change (delivery fee joins the payable total but does not earn
points). SQL cannot patch a function body in place, so each is lifted verbatim from the M4 migration,
the specific lines are swapped (asserting each swap happens exactly once so drift fails loudly), and the
rollback re-emits the untouched M4 text.

  python3 scripts/build-m41-migration.py
"""
import pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
M4 = (ROOT / "supabase/migrations/20260930001000_member_account_live.sql").read_text()
OUT = ROOT / "supabase/migrations/20260930002000_checkout_orders.sql"
MIRROR = ROOT / "drizzle/migrations/0011_checkout_orders.sql"
RB_OUT = ROOT / "supabase/rollbacks/20260930002000_checkout_orders_rollback.sql"


def fn(name: str) -> str:
    m = re.search(r"CREATE OR REPLACE FUNCTION public\.%s\(.*?^\$\$;\n" % re.escape(name), M4, re.S | re.M)
    if not m:
        raise SystemExit(f"{name} not found in M4 migration")
    return m.group(0)


def swap(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one occurrence of: {old[:70]!r}"
    return text.replace(old, new)


redeem = fn("redeem_loyalty_points")
redeem = swap(redeem, "      total_rand = v_subtotal - v_discount\n",
              "      total_rand = v_subtotal + v_order.delivery_fee_rand - v_discount\n")
redeem = swap(redeem, "    'total', v_subtotal - v_discount, 'balance', v_balance);",
              "    'total', v_subtotal + v_order.delivery_fee_rand - v_discount, 'balance', v_balance);")

accrue = fn("accrue_order_loyalty")
accrue = swap(accrue, "  -- Points are earned on what was actually paid (after any redeemed points).\n  v_points := public._loyalty_points_for_amount(v_order.total_rand);",
              "  -- Points are earned on what was actually paid for goods: after any redeemed points, and\n  -- excluding the delivery fee.\n  v_points := public._loyalty_points_for_amount(v_order.total_rand - v_order.delivery_fee_rand);")

check = fn("reorder_check")
check = swap(check, "  v_orderable boolean;\nBEGIN\n", "  v_orderable boolean;\n  v_fee numeric(10,2) := 0;\nBEGIN\n")
check = swap(check, "    RAISE EXCEPTION 'order_not_found';\n  END IF;\n\n  WITH grouped AS (",
              "    RAISE EXCEPTION 'order_not_found';\n  END IF;\n"
              "  -- Delivery is re-priced at today's fee; a retired option blocks the reorder.\n"
              "  IF v_order.delivery_method IS NOT NULL THEN\n"
              "    SELECT d.fee_rand INTO v_fee FROM public.delivery_options d\n"
              "    WHERE d.code = v_order.delivery_method AND d.is_active;\n"
              "    IF NOT FOUND THEN\n"
              "      RAISE EXCEPTION 'delivery_unavailable: the delivery option on that order is no longer offered';\n"
              "    END IF;\n  END IF;\n\n  WITH grouped AS (")
check = swap(check, "    'current_total', CASE WHEN COALESCE(v_orderable, false) THEN v_total ELSE NULL END);",
             "    'delivery_fee', v_fee,\n    'current_total', CASE WHEN COALESCE(v_orderable, false) THEN v_total + v_fee ELSE NULL END);")

reorder = fn("create_reorder")
reorder = swap(reorder, "    'Reorder of ' || v_source.order_number, 'ro-' || md5(p_idempotency_key), 30);\n"
               "  v_result := v_result || jsonb_build_object('source_order_id', p_source_order_id);",
               "    'Reorder of ' || v_source.order_number, 'ro-' || md5(p_idempotency_key), 120);\n"
               "  -- Carry the delivery method, address snapshot and payment method over (fee re-priced today).\n"
               "  IF v_source.delivery_method IS NOT NULL THEN\n"
               "    PERFORM public._checkout_apply_delivery((v_result->>'order_id')::uuid, v_source.delivery_method,\n"
               "      v_source.delivery_address, COALESCE(v_source.payment_method, 'eft'));\n"
               "    v_result := v_result || jsonb_build_object('total',\n"
               "      (SELECT o.total_rand FROM public.orders o WHERE o.id = (v_result->>'order_id')::uuid));\n"
               "  END IF;\n"
               "  v_result := v_result || jsonb_build_object('source_order_id', p_source_order_id);")

patched = "\n".join([redeem, accrue, check, reorder])
tpl = (ROOT / "scripts/m41-migration.template.sql").read_text()
assert "-- @@PATCHED_FUNCTIONS@@\n" in tpl
body = tpl.replace("-- @@PATCHED_FUNCTIONS@@\n", patched)
OUT.write_text(body)
MIRROR.write_text(body)

rb = (ROOT / "scripts/m41-rollback.template.sql").read_text()
restored = "\n".join([fn("redeem_loyalty_points"), fn("accrue_order_loyalty"), fn("reorder_check"), fn("create_reorder")])
RB_OUT.write_text(rb.replace("-- @@RESTORED_FUNCTIONS@@\n", restored))
print("wrote", OUT.relative_to(ROOT), MIRROR.relative_to(ROOT), RB_OUT.relative_to(ROOT))
