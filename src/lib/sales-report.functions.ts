import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";
import { emailSalesReport, getSalesReport } from "@/lib/sales-report.server";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const getSalesReportFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ from: day, to: day }).parse(d))
  .handler(({ context, data }) => getSalesReport(context.userId, data.from, data.to));

export const emailSalesReportFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ day, key: z.string().min(8).max(128) }).parse(d))
  .handler(({ context, data }) => emailSalesReport(context.userId, data.day, data.key));
