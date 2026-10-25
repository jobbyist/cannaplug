import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

const key = z.string().min(8).max(100);
const opt = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const campaign = z.object({
  subject: z.string().trim().min(3).max(120),
  preheader: opt(150),
  headline: z.string().trim().min(3).max(120),
  body: z.string().trim().min(10).max(5000),
  ctaLabel: opt(40),
  ctaUrl: opt(500).refine((v) => v === null || /^https:\/\/[^\s<>"]+$/.test(v), {
    message: "The button link must start with https://",
  }),
});

export const listCampaignsFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { listCampaigns } = await import("@/lib/email-campaigns.server");
    return listCampaigns(context.userId);
  });

export const saveCampaignFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ id: z.string().uuid().nullable(), input: campaign, key }).parse(d))
  .handler(async ({ context, data }) => {
    const { saveCampaign } = await import("@/lib/email-campaigns.server");
    return saveCampaign(context.userId, data.id, data.input, data.key);
  });

export const testCampaignFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ id: z.string().uuid(), key }).parse(d))
  .handler(async ({ context, data }) => {
    const { testCampaign } = await import("@/lib/email-campaigns.server");
    return testCampaign(context.userId, data.id, data.key);
  });

export const sendCampaignFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ id: z.string().uuid(), key }).parse(d))
  .handler(async ({ context, data }) => {
    const { sendCampaign } = await import("@/lib/email-campaigns.server");
    return sendCampaign(context.userId, data.id, data.key);
  });

export const emailActivityFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { emailActivity } = await import("@/lib/email-campaigns.server");
    return emailActivity(context.userId);
  });

/** Account Settings: a member's own "email me news and offers" choice. */
export const getMyNewsletterFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { myNewsletter } = await import("@/lib/email-campaigns.server");
    return myNewsletter(context.userId);
  });

export const setMyNewsletterFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ subscribe: z.boolean(), key }).parse(d))
  .handler(async ({ context, data }) => {
    const { setMyNewsletter } = await import("@/lib/email-campaigns.server");
    return setMyNewsletter(context.userId, data.subscribe, data.key);
  });
