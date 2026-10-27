import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SalesReport } from "@/lib/sales-report-logic";

/**
 * Sales reports for /admin (Overview and Reports) and the daily manager email. The numbers are worked out in
 * the database (_sales_report); these wrappers pass the signed-in staff member as p_actor and the RPCs check
 * their role. Reports carry no customer names or contact details.
 */
export async function getSalesReport(
  userId: string,
  from: string,
  to: string,
): Promise<SalesReport> {
  const { data, error } = await supabaseAdmin.rpc("sales_report", {
    p_actor: userId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(error.message);
  return data as unknown as SalesReport;
}

export async function emailSalesReport(userId: string, day: string, key: string) {
  const { data, error } = await supabaseAdmin.rpc("sales_report_email", {
    p_actor: userId,
    p_day: day,
    p_idempotency_key: key,
  });
  if (error) throw new Error(error.message);
  return data as { day: string; recipients: number; replayed?: boolean };
}
