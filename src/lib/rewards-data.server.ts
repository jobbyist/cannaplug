import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { friendlyMemberError, MemberError } from "@/lib/member-logic";
import { normaliseUsername } from "@/lib/rewards-logic";

/**
 * Usernames, referral codes and the rewards summary. The acting member always comes from the verified session
 * (never from the browser); the database decides everything (who is eligible to refer, what is free, who is staff).
 */

export type UsernameStatus = "ok" | "invalid" | "reserved" | "taken";
export type ReferralCodeCheck = {
  valid: boolean;
  reason?: "invalid" | "not_found" | "inactive";
  code?: string;
};
export type RewardsSummary = {
  username: string | null;
  /** Imported members may change the username from the file once, after submitting their ID. */
  username_change: "none" | "needs_id" | "available" | "used";
  /** True while the username was generated for the member: they can replace or keep it once. */
  username_auto: boolean;
  can_change: boolean;
  can_refer: boolean;
  referral_points: number;
  referral_min_spend: number;
  referred: {
    name: string;
    status: "pending" | "qualified";
    joined_at: string;
    qualified_at: string | null;
  }[];
  points_from_referrals: number;
  rewards: { code: string; name: string; description: string; points_cost: number }[];
};

/** Is this username free? Public (the sign-up form asks before an account exists). Reads nothing about anyone. */
export async function checkUsername(
  raw: string,
  email?: string,
): Promise<{ status: UsernameStatus }> {
  // With an email (the sign-up form) an imported member's own username counts as free for them.
  const { data, error } = email
    ? await supabaseAdmin.rpc("username_check_signup", {
        p_email: email,
        p_username: normaliseUsername(raw),
      })
    : await supabaseAdmin.rpc("username_check", { p_username: normaliseUsername(raw) });
  if (error) throw friendlyMemberError(error);
  return { status: data as UsernameStatus };
}

/** Is this a referral code someone can use at sign-up? Public; says only valid or why not. */
export async function checkReferralCode(raw: string): Promise<ReferralCodeCheck> {
  const { data, error } = await supabaseAdmin.rpc("referral_code_check", { p_code: raw });
  if (error) throw friendlyMemberError(error);
  return data as unknown as ReferralCodeCheck;
}

/** A member chooses their username once; it becomes their referral code. */
export async function setMemberUsername(userId: string, username: string, key: string) {
  const { data, error } = await supabaseAdmin.rpc("member_set_username", {
    p_user_id: userId,
    p_username: normaliseUsername(username),
    p_idempotency_key: key,
  });
  if (error) throw friendlyMemberError(error);
  return data as unknown as { username: string };
}

export async function getRewardsSummary(userId: string): Promise<RewardsSummary> {
  // A member whose ID is verified (or who is staff) and has no username yet is given a generated one first.
  const ensured = await supabaseAdmin.rpc("member_ensure_username", { p_user_id: userId });
  if (ensured.error) console.error("member_ensure_username failed", ensured.error.message);
  const { data, error } = await supabaseAdmin.rpc("member_rewards_summary", { p_user_id: userId });
  if (error) throw new MemberError("Could not load your rewards. Please retry.");
  const change = await supabaseAdmin.rpc("member_username_change_state", { p_user_id: userId });
  if (change.error) throw new MemberError("Could not load your rewards. Please retry.");
  return {
    ...(data as unknown as Omit<RewardsSummary, "username_change">),
    username_change: change.data as RewardsSummary["username_change"],
  };
}
