import type { IdCreditSummary } from "@/lib/id-credits.server";

export type CreditHealth = "ok" | "low" | "depleted";
export function creditHealth(
  s: Pick<IdCreditSummary, "available" | "cost_per_check" | "low_balance_threshold">,
): CreditHealth {
  if (s.available < Math.max(s.cost_per_check, 1)) return "depleted";
  if (s.available <= s.low_balance_threshold) return "low";
  return "ok";
}
