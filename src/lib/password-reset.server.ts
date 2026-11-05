import { RESET_REDIRECT } from "@/lib/auth-messages";
import { sendWithResend, senderFromEnv, type ResendFetch } from "@/lib/email/sender";
import { renderTemplate } from "@/lib/notifications/templates";
import { SITE_URL } from "@/lib/site";

/**
 * Branded password-reset emails (5 Nov 2026). Supabase makes the one-time link (`auth.admin.generateLink`), and this
 * module emails it through Resend from the verified CannaPlug sender, in the same design as every other CannaPlug
 * email. The database decides whether an email may go out (per-address and per-connection limits, the daily Resend
 * allowance) and records the outcome, keeping only a hash of the address.
 *
 * Privacy: the answer is the same whether or not an account exists, and the link (a credential) is never logged,
 * stored or returned. Without RESEND_API_KEY it falls back to Supabase's own mailer, so resets never stop working.
 */

type RpcResult = { data: unknown; error: { message: string } | null };
export type ResetAdmin = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  auth: {
    resetPasswordForEmail: (
      email: string,
      opts: { redirectTo: string },
    ) => PromiseLike<{ error: { message: string } | null }>;
    admin: {
      generateLink: (params: {
        type: "recovery";
        email: string;
        options: { redirectTo: string };
      }) => PromiseLike<{
        data: {
          properties?: { action_link?: string } | null;
          user?: { user_metadata?: Record<string, unknown> } | null;
        } | null;
        error: { message: string; status?: number; code?: string } | null;
      }>;
    };
  };
};

export type ResetDeps = {
  admin: ResetAdmin;
  fetchFn: ResendFetch;
  env: Record<string, string | undefined>;
};

export type ResetOutcome =
  { ok: true } | { ok: false; reason: "email_limit" | "ip_limit" | "daily_limit" | "send_failed" };

/** Words for a refused or failed request. None of them says whether the address has an account. */
export const RESET_MESSAGES: Record<Exclude<ResetOutcome, { ok: true }>["reason"], string> = {
  email_limit:
    "We've already sent reset links to this address in the last hour. Check your inbox and spam folder for the newest one, or try again later.",
  ip_limit: "Too many reset requests from this connection. Please try again in an hour.",
  daily_limit:
    "We can't send email right now. Please try again tomorrow, or call us on +27 68 291 2107 and we'll help you get back in.",
  send_failed:
    "We couldn't send the email just now. Please try again in a few minutes, or call us on +27 68 291 2107.",
};

const notFound = (e: { message: string; status?: number; code?: string }) =>
  e.status === 404 || e.code === "user_not_found" || /not.?found|no user/i.test(e.message);

export async function sendPasswordResetEmail(
  input: { email: string; ipHash: string | null; actor: string | null; key: string },
  deps: ResetDeps,
): Promise<ResetOutcome> {
  const email = input.email.trim().toLowerCase();
  const begin = await deps.admin.rpc("password_reset_begin", {
    p_email: email,
    p_ip_hash: input.ipHash,
    p_actor: input.actor,
    p_idempotency_key: input.key,
  });
  if (begin.error) throw new Error(begin.error.message);
  const decision = (begin.data ?? {}) as {
    allowed?: boolean;
    reason?: "email_limit" | "ip_limit" | "daily_limit";
    request_id?: string;
    replayed?: boolean;
  };
  if (!decision.allowed) return { ok: false, reason: decision.reason ?? "daily_limit" };
  // A double-click or retry: the first call already handled it.
  if (decision.replayed || !decision.request_id) return { ok: true };
  const requestId = decision.request_id;
  const finish = (status: "sent" | "no_account" | "failed") =>
    deps.admin.rpc("password_reset_finish", { p_request_id: requestId, p_status: status });

  const apiKey = deps.env["RESEND_API_KEY"]?.trim();
  if (!apiKey) {
    const { error } = await deps.admin.auth.resetPasswordForEmail(email, {
      redirectTo: RESET_REDIRECT,
    });
    await finish(error ? "failed" : "sent");
    // Supabase answers the same for unknown addresses, so a failure here says nothing about an account.
    return error ? { ok: false, reason: "send_failed" } : { ok: true };
  }

  const { data, error } = await deps.admin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: RESET_REDIRECT },
  });
  if (error) {
    if (notFound(error)) {
      await finish("no_account");
      return { ok: true }; // same answer as a real account
    }
    await finish("failed");
    return { ok: false, reason: "send_failed" };
  }
  const link = data?.properties?.action_link;
  if (!link) {
    await finish("failed");
    return { ok: false, reason: "send_failed" };
  }

  const firstName = data?.user?.user_metadata?.["first_name"];
  const rendered = renderTemplate(
    "password_reset",
    {
      reset_url: link,
      first_name: typeof firstName === "string" ? firstName : "",
      by_staff: input.actor !== null,
    },
    { siteUrl: deps.env["PUBLIC_APP_URL"]?.trim() || SITE_URL },
  );
  if (!rendered) throw new Error("password_reset template missing");
  try {
    const res = await sendWithResend(
      deps.fetchFn,
      apiKey,
      senderFromEnv(deps.env),
      { to: [email], subject: rendered.subject, html: rendered.html, text: rendered.text },
      `pw-reset:${requestId}`,
    );
    const ok = res.status >= 200 && res.status < 300;
    await finish(ok ? "sent" : "failed");
    return ok ? { ok: true } : { ok: false, reason: "send_failed" };
  } catch {
    await finish("failed");
    return { ok: false, reason: "send_failed" };
  }
}

/** The real dependencies: the service-role client, the platform fetch and the server environment. */
export async function liveResetDeps(): Promise<ResetDeps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return {
    admin: supabaseAdmin as unknown as ResetAdmin,
    fetchFn: async (url, init) => {
      const r = await fetch(url, init);
      return { ok: r.ok, status: r.status, text: () => r.text() };
    },
    env: process.env,
  };
}
