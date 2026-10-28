import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkReferralCode, checkUsername, setMemberUsername } from "@/lib/rewards-data.server";

const username = z.string().trim().min(1).max(40);

/** Public: the sign-up form checks a username is free before it creates the account. */
export const checkUsernameFn = createServerFn({ method: "POST" })
  .validator((d) => z.object({ username }).parse(d))
  .handler(({ data }) => checkUsername(data.username));

/** Public: the sign-up form checks a referral code (a member's username) before it creates the account. */
export const checkReferralCodeFn = createServerFn({ method: "POST" })
  .validator((d) => z.object({ code: z.string().trim().min(1).max(40) }).parse(d))
  .handler(({ data }) => checkReferralCode(data.code));

/** A signed-in member chooses their username (once). The member is the verified session, never a field. */
export const setUsernameFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ username, key: z.string().min(8).max(120) }).parse(d))
  .handler(({ context, data }) => setMemberUsername(context.userId, data.username, data.key));
