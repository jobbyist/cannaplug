import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const csv = z
  .string()
  .min(10)
  .max(2 * 1024 * 1024);

export const previewCatalogueImportFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => z.object({ csv }).parse(data))
  .handler(async ({ context, data }) => {
    const { previewCatalogueImport } = await import("@/lib/catalogue-import.server");
    return previewCatalogueImport(context.userId, data.csv);
  });

export const commitCatalogueImportFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) =>
    z.object({ csv, deactivateMissing: z.boolean(), key: z.string().min(8).max(100) }).parse(data),
  )
  .handler(async ({ context, data }) => {
    const { commitCatalogueImport } = await import("@/lib/catalogue-import.server");
    return commitCatalogueImport(context.userId, data.csv, data.deactivateMissing, data.key);
  });
