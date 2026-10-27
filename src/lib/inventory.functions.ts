import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";
import { listInventory, listStockHistory, setLowStockThreshold } from "@/lib/inventory-data.server";

/** /admin → Inventory. The acting user comes only from the session; stock changes go through pos.functions. */

export const listInventoryFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(({ context }) => listInventory(context.userId));

export const listStockHistoryFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ productId: z.string().uuid() }).parse(d))
  .handler(({ context, data }) => listStockHistory(context.userId, data.productId));

export const setLowStockThresholdFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({ productId: z.string().uuid(), threshold: z.number().int().min(0).max(100000) })
      .parse(d),
  )
  .handler(({ context, data }) =>
    setLowStockThreshold(context.userId, data.productId, data.threshold),
  );
