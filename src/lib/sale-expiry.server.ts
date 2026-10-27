import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Ends every sale whose end date has passed (regular price back, audit row written) before anything is priced.
 * pg_cron also runs this every minute; calling it here closes the gap so neither the till nor online checkout
 * ever charges an expired sale price. Best effort: a failure here must never block a sale, the scheduled sweep
 * and checkout's own total check still apply. `actor` is the staff member, or null for a customer request.
 */
export async function endExpiredSales(actor: string | null): Promise<void> {
  try {
    await supabaseAdmin.rpc("products_end_expired_sales", { p_actor: actor });
  } catch {
    // ignored: see above
  }
}
