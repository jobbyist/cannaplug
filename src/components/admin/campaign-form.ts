export type Form = {
  subject: string;
  preheader: string;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
};

/** Problems the manager can fix before saving (the database checks the same rules). */
export function campaignProblem(f: Form): string | null {
  if (f.subject.trim().length < 3) return "Add a subject line (at least 3 characters).";
  if (f.headline.trim().length < 3) return "Add a headline (at least 3 characters).";
  if (f.body.trim().length < 10) return "Write the message (at least 10 characters).";
  const label = f.ctaLabel.trim();
  const url = f.ctaUrl.trim();
  if (Boolean(label) !== Boolean(url)) return "A button needs both a label and a link, or neither.";
  if (url && !/^https:\/\/[^\s<>"]+$/.test(url)) return "The button link must start with https://";
  return null;
}
