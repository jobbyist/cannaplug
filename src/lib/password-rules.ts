export const MIN_PASSWORD = 8;

/** Rules a new password must meet before it is sent to Supabase Auth. */
export function passwordProblem(next: string, confirm: string): string | null {
  if (next.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (next.length > 72) return "Use 72 characters or fewer.";
  if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return "Use letters and at least one number.";
  if (next !== confirm) return "The two passwords do not match.";
  return null;
}

/** The same rules as a checklist, for live hints while typing. */
export function passwordChecks(next: string): { label: string; ok: boolean }[] {
  return [
    { label: `At least ${MIN_PASSWORD} characters`, ok: next.length >= MIN_PASSWORD },
    { label: "Letters and at least one number", ok: /[A-Za-z]/.test(next) && /[0-9]/.test(next) },
  ];
}
