import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) =>
  text(max)
    .nullish()
    .transform((v) => (v ? v : null));

const waiverForm = z
  .object({
    customer_name: text(120).min(2),
    date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    id_number: text(40).min(4),
    age_confirmed: z.boolean(),
    popia_consent: z.boolean(),
    alcohol: z
      .object({ had: z.boolean(), hours_ago: z.number().min(0).max(72).nullish() })
      .strict(),
    drugs: z.object({ had: z.boolean(), details: optText(300) }).strict(),
    medication: z.object({ had: z.boolean(), details: optText(300) }).strict(),
    under_influence: z.boolean(),
    conditions: z
      .array(z.enum(["asthma", "heart", "epilepsy", "low_bp", "anxiety", "pregnant", "other"]))
      .max(7),
    condition_details: optText(500),
    emergency: z
      .object({
        name: text(120).min(2),
        relationship: optText(60),
        phone: text(30).min(7),
        alt_phone: optText(30),
      })
      .strict(),
    // A PNG drawn on the screen; the database checks the format and caps it at 200 KB.
    signature: z
      .string()
      .max(200_000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
      .nullish(),
    staff_noted_signs: z.boolean(),
    staff_details: optText(1000),
  })
  .strict();

/** Any staff member can sign a customer in; the database refuses anyone else. */
export const createDabWaiverFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) => waiverForm.parse(data))
  .handler(async ({ context, data }) => {
    const { createDabWaiver } = await import("@/lib/waiver-data.server");
    return createDabWaiver(context.userId, data);
  });

/** Managers and admins only (the database checks the role). */
export const getDabWaiverFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) => z.object({ waiverId: z.string().uuid() }).parse(data))
  .handler(async ({ context, data }) => {
    const { getDabWaiver } = await import("@/lib/waiver-data.server");
    return getDabWaiver(context.userId, data.waiverId);
  });

export const listDabWaiversFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) =>
    z
      .object({
        search: text(60).optional(),
        before: z.string().datetime({ offset: true }).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .default({})
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    const { listDabWaivers } = await import("@/lib/waiver-data.server");
    return listDabWaivers(context.userId, data);
  });

export const recordWaiverIncidentFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) =>
    z
      .object({
        waiverId: z.string().uuid(),
        text: text(1000).min(3),
        emergencyServices: z.boolean(),
        emergencyContact: z.boolean(),
        time: optText(20),
        notes: optText(1000),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    const { recordWaiverIncident } = await import("@/lib/waiver-data.server");
    await recordWaiverIncident(context.userId, data);
    return { ok: true };
  });
