import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

const paper = z.enum(["80mm", "58mm", "a4"]);
const saleId = z.string().uuid();

export const getPosReceiptFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) => z.object({ saleId }).parse(data))
  .handler(async ({ context, data }) => {
    const { getPosReceipt } = await import("@/lib/receipts/receipts.server");
    return getPosReceipt(context.userId, data.saleId);
  });

export const recordCashReceivedFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) =>
    z.object({ saleId, cashReceived: z.number().positive().max(1_000_000) }).parse(data),
  )
  .handler(async ({ context, data }) => {
    const { recordCashReceived } = await import("@/lib/receipts/receipts.server");
    return recordCashReceived(context.userId, data.saleId, data.cashReceived);
  });

export const posReceiptPdfFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) => z.object({ saleId, paper }).parse(data))
  .handler(async ({ context, data }) => {
    const { posReceiptPdf } = await import("@/lib/receipts/receipts.server");
    return posReceiptPdf(context.userId, data.saleId, data.paper);
  });

export const emailPosReceiptFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) =>
    z.object({ saleId, email: z.string().trim().email().max(254), paper }).parse(data),
  )
  .handler(async ({ context, data }) => {
    const { emailPosReceipt } = await import("@/lib/receipts/receipts.server");
    return emailPosReceipt(context.userId, data.saleId, data.email, data.paper);
  });

const settings = z.object({
  trading_name: z.string().trim().min(1).max(80),
  legal_name: z.string().trim().min(1).max(120),
  registration_number: z.string().trim().max(40).nullable(),
  licence_lines: z.array(z.string().trim().min(1).max(80)).max(4),
  address: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).nullable(),
  email: z.string().trim().email().max(120).nullable(),
  vat_registered: z.boolean(),
  vat_number: z
    .string()
    .trim()
    .regex(/^4\d{9}$/, "VAT number: 10 digits starting with 4")
    .nullable(),
  vat_rate: z.number().positive().max(99),
  footer_message: z.string().trim().max(200).nullable(),
  returns_policy: z.string().trim().max(300).nullable(),
  default_paper: paper,
});

export const getReceiptSettingsFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getReceiptSettings } = await import("@/lib/receipts/receipts.server");
    return getReceiptSettings(context.userId);
  });

export const saveReceiptSettingsFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) => settings.parse(data))
  .handler(async ({ context, data }) => {
    const { saveReceiptSettings } = await import("@/lib/receipts/receipts.server");
    return saveReceiptSettings(context.userId, data);
  });
