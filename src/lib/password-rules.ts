export const MIN_PASSWORD = 8;

/** Rules a new password must meet before it is sent to Supabase Auth. */
export function passwordProblem(next: string, confirm: string): string | null {
  if (next.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (next.length > 72) return "Use 72 characters or fewer.";
  if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return "Use letters and at least one number.";
  if (next !== confirm) return "The two passwords do not match.";
  return null;
}
