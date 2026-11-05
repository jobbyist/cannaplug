import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * "Forgot password": anyone can ask, so the database limits how often (per address and per connection) and the
 * answer never says whether the address has an account. The email is sent by the server through Resend; the
 * browser sends only the address and a one-time key.
 */
export const requestPasswordResetFn = createServerFn({ method: "POST" })
  .validator((d) =>
    z
      .object({
        email: z.string().trim().toLowerCase().email().max(254),
        key: z.string().min(8).max(120),
        // honeypot: real people never see or fill this field
        website: z.string().max(200).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    if (data.website) return { ok: true as const };
    const [{ getRequest }, { hashIp }, reset] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/payments/service.server"),
      import("@/lib/password-reset.server"),
    ]);
    const ip = getRequest().headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const outcome = await reset.sendPasswordResetEmail(
      { email: data.email, ipHash: hashIp(ip), actor: null, key: data.key },
      await reset.liveResetDeps(),
    );
    if (!outcome.ok) throw new Error(reset.RESET_MESSAGES[outcome.reason]);
    return { ok: true as const };
  });
