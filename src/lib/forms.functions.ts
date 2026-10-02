import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Public website forms. No account is needed, so every submission is validated, honeypot-checked and
 * rate-limited by hashed IP in the database. Nothing is emailed from the request: the RPCs enqueue
 * notifications that the cron dispatcher sends from "Cannaplug Support <update@updates.cannaplug012.co.za>".
 */
export const SITE_INBOX = "info@cannaplug012.co.za";

const email = z.string().trim().toLowerCase().email().max(254);

async function clientIpHash(): Promise<string | null> {
  const [{ getRequest }, { hashIp }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("@/lib/payments/service.server"),
  ]);
  const ip = getRequest().headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return hashIp(ip);
}

const FRIENDLY: Record<string, string> = {
  rate_limited: "You have sent a few messages already — please try again in an hour.",
};
function friendly(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const code = /^([a-z_]+)/.exec(raw)?.[1] ?? "";
  return new Error(
    FRIENDLY[code] ?? "We could not send that just now. Please try again or email us directly.",
  );
}

export const submitContactFn = createServerFn({ method: "POST" })
  .validator((d) =>
    z
      .object({
        name: z.string().trim().min(2).max(120),
        email,
        subject: z.string().trim().min(2).max(200),
        message: z.string().trim().min(5).max(4000),
        // honeypot: real people never see or fill this field
        website: z.string().max(200).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    if (data.website) return { ok: true as const }; // bot: pretend success, store nothing
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.rpc("contact_submit", {
      p_name: data.name,
      p_email: data.email,
      p_subject: data.subject,
      p_message: data.message,
      p_ip_hash: (await clientIpHash()) as string,
      p_inbox: process.env["CONTACT_INBOX"]?.trim() || SITE_INBOX,
    });
    if (error) throw friendly(error);
    return { ok: true as const };
  });

export const subscribeNewsletterFn = createServerFn({ method: "POST" })
  .validator((d) => z.object({ email, website: z.string().max(200).optional() }).parse(d))
  .handler(async ({ data }) => {
    if (data.website) return { ok: true as const };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.rpc("newsletter_subscribe", {
      p_email: data.email,
      p_ip_hash: (await clientIpHash()) as string,
      p_source: "website_footer",
    });
    if (error) throw friendly(error);
    return { ok: true as const };
  });

export const unsubscribeNewsletterFn = createServerFn({ method: "POST" })
  .validator((d) => z.object({ token: z.string().regex(/^[0-9a-f]{48}$/) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.rpc("newsletter_unsubscribe", { p_token: data.token });
    if (error) throw friendly(error);
    return { ok: true as const };
  });
