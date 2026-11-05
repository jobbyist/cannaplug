import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { RESET_REDIRECT, authProblem } from "@/lib/auth-messages";

/**
 * A manager sends a member the standard password-reset email (staff feedback, 5 Nov 2026: members who lost the
 * password their phone suggested were locked out). Staff never see or set the password; the member chooses it from
 * the link. The browser sends only the member's id; the email address is looked up here. The audit row records who
 * asked and for whom, never the email address.
 */
export async function sendMemberPasswordReset(actor: string, memberId: string) {
  await assertRole(actor, "manager");
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(memberId);
  if (error || !data.user) throw new Error("That member could not be found.");
  const email = data.user.email;
  if (!email) throw new Error("That member has no email address on their account.");
  const { error: sendError } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
    redirectTo: RESET_REDIRECT,
  });
  if (sendError) {
    const p = authProblem(sendError.message);
    throw new Error(
      p.kind === "rate_limited"
        ? p.message
        : "The reset email could not be sent. Please try again.",
    );
  }
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: actor,
    action: "member_password_reset_sent",
    entity_type: "user",
    entity_id: memberId,
    target_user_id: memberId,
    metadata: {},
  });
  return { sent: true as const };
}
