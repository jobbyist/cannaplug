#!/usr/bin/env python3
"""Assembles the Milestone 4 migration and rollback.

The migration must replace ONE line inside pos_refund_sale (the hard-coded "1 point per R10" refund
target) so POS refunds follow the same loyalty_rules as every other accrual. SQL has no way to patch a
function body in place, so the function text is lifted verbatim from the Milestone 3 migration and the
single expression is swapped. The rollback re-creates the original M3 text of the two POS functions
the same way, so neither file can drift from M3.

  python3 scripts/build-m4-migration.py
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
M3 = (ROOT / "supabase/migrations/20260929010000_pos_atomic_inventory.sql").read_text()
SRC = ROOT / "scripts/m4-migration.template.sql"
OUT = ROOT / "supabase/migrations/20260930001000_member_account_live.sql"
MIRROR = ROOT / "drizzle/migrations/0010_member_account_live.sql"
RB_SRC = ROOT / "scripts/m4-rollback.template.sql"
RB_OUT = ROOT / "supabase/rollbacks/20260930001000_member_account_live_rollback.sql"


def function_text(name: str) -> str:
    m = re.search(
        r"^CREATE OR REPLACE FUNCTION public\.%s\(.*?^\$\$;\n" % re.escape(name),
        M3,
        re.S | re.M,
    )
    if not m:
        raise SystemExit(f"function {name} not found in the M3 migration")
    return m.group(0)


OLD_TARGET = (
    "v_target := floor((v_sale.total - (SELECT COALESCE(SUM(r.amount), 0) FROM public.pos_refunds r "
    "WHERE r.sale_id = p_sale_id)) / 10)::integer;"
)
NEW_TARGET = (
    "v_target := public._loyalty_points_for_amount(v_sale.total - (SELECT COALESCE(SUM(r.amount), 0) "
    "FROM public.pos_refunds r WHERE r.sale_id = p_sale_id));"
)

refund = function_text("pos_refund_sale")
assert refund.count(OLD_TARGET) == 1, "expected exactly one hard-coded R10 refund target in M3"
refund_new = refund.replace(OLD_TARGET, NEW_TARGET)

body = SRC.read_text().replace("-- @@POS_REFUND_SALE@@\n", refund_new)
OUT.write_text(body)
MIRROR.write_text(body)

rb = RB_SRC.read_text()
rb = rb.replace("-- @@POS_REFUND_SALE@@\n", refund)
rb = rb.replace("-- @@ACCRUE_POS_LOYALTY@@\n", function_text("accrue_pos_loyalty"))
RB_OUT.write_text(rb)
print("wrote", OUT.relative_to(ROOT), MIRROR.relative_to(ROOT), RB_OUT.relative_to(ROOT))
