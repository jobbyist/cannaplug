/** Turns Supabase Auth errors into words a budtender can act on. Never says whether an account exists. */
export function signInMessage(raw: string): string {
  if (/invalid login credentials|invalid.*password|user not found/i.test(raw))
    return "That email and password don't match. Check them, or use Forgot password.";
  if (/email not confirmed/i.test(raw))
    return "This email address hasn't been confirmed yet. Ask a manager for help.";
  if (/rate|too many|security purposes/i.test(raw))
    return "Too many attempts. Wait a minute, then try again.";
  if (/network|fetch/i.test(raw)) return "No connection. Check the internet and try again.";
  return "Sign-in didn't work. Try again, or ask a manager.";
}
