import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { RESET_MESSAGES, liveResetDeps, sendPasswordResetEmail } from "@/lib/password-reset.server";

/**
 * A manager sends a member the branded password-reset email (staff feedback, 5 Nov 2026: members who lost the
 * password their phone suggested were locked out). Staff never see or set the password; the member chooses it from
 * the link. The browser sends only the member's id; the email address is looked up here. The database checks the
 * manager role again, limits how often, and audits who asked, never the email address.
 */
export async function sendMemberPasswordReset(actor: string, memberId: string, key: string) {
  await assertRole(actor, "manager");
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(memberId);
  if (error || !data.user) throw new Error("That member could not be found.");
  const email = data.user.email;
  if (!email) throw new Error("That member has no email address on their account.");
  const outcome = await sendPasswordResetEmail(
    { email, ipHash: null, actor, key },
    await liveResetDeps(),
  );
  if (!outcome.ok) throw new Error(RESET_MESSAGES[outcome.reason]);
  return { sent: true as const };
}
