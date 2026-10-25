import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

const csv = z
  .string()
  .min(5)
  .max(2 * 1024 * 1024);

/** Manager+: current products as a CSV in the template's columns. */
export const exportProductsCsvFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { exportProductsCsv } = await import("@/lib/product-csv.server");
    return exportProductsCsv(context.userId);
  });

/** Manager+: dry run of an uploaded product CSV. Writes nothing. */
export const previewProductCsvFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) => z.object({ csv }).parse(data))
  .handler(async ({ context, data }) => {
    const { previewProductCsv } = await import("@/lib/product-csv.server");
    return previewProductCsv(context.userId, data.csv);
  });

/** Manager+: applies the uploaded product CSV in one transaction. */
export const commitProductCsvFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) => z.object({ csv, key: z.string().min(8).max(100) }).parse(data))
  .handler(async ({ context, data }) => {
    const { commitProductCsv } = await import("@/lib/product-csv.server");
    return commitProductCsv(context.userId, data.csv, data.key);
  });
