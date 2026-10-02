/**
 * "Your document is ready" notification.
 *
 * The message deliberately contains nothing about the document: no type, no practitioner, no member
 * name, no medicine, no attachment. It only points to the authenticated member area, where access is
 * checked and audited. Medical documents are never attached to ordinary email.
 */

export const DOCUMENT_READY_SUBJECT = "Your CannaPlug medical document is ready";

export type ReadyEmail = { subject: string; text: string; html: string };

export function buildDocumentReadyEmail(portalUrl: string): ReadyEmail {
  const url = new URL(portalUrl); // throws on a malformed URL rather than mailing a broken link
  if (url.protocol !== "https:" && url.hostname !== "localhost")
    throw new Error("The document link must be https");
  const link = url.toString();
  const text = [
    "Your CannaPlug medical document is ready.",
    "",
    "Sign in to your CannaPlug account to view it:",
    link,
    "",
    "For your privacy, nothing from the document is included in this email.",
    "If you were not expecting this message, please contact CannaPlug support.",
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1a1f1a;line-height:1.5">
<p>Your CannaPlug medical document is ready.</p>
<p><a href="${link}">Sign in to view it</a></p>
<p style="color:#555;font-size:13px">For your privacy, nothing from the document is included in this email.
If you were not expecting this message, please contact CannaPlug support.</p>
</body></html>`;
  return { subject: DOCUMENT_READY_SUBJECT, text, html };
}
