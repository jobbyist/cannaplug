# Supabase Auth email templates (branded)

Sign-up confirmation, password reset, magic link, email change and invite emails are sent by **Supabase Auth**, not by the
app's notification queue, so their look is configured in Supabase:

1. Dashboard -> Authentication -> Emails -> **SMTP Settings**: enable custom SMTP with Resend
   (host `smtp.resend.com`, port 465, user `resend`, password = the Resend API key, sender `updates@cannaplug.co.za`,
   sender name `Cannaplug Support`). The domain `cannaplug.co.za` must be verified in Resend.
2. Dashboard -> Authentication -> Emails -> **Templates**: paste each file in this folder into its template
   (Confirm signup = `confirmation.html`, Reset password = `recovery.html`, Magic link = `magic_link.html`,
   Change email = `email_change.html`, Invite user = `invite.html`) and use the subject lines below.
3. Dashboard -> Authentication -> URL Configuration: Site URL = the production site; add the preview/staging URLs to the allow-list.

| Template | Subject |
| --- | --- |
| Confirm signup | Confirm your Cannaplug account |
| Reset password | Reset your Cannaplug password |
| Magic link | Your Cannaplug sign-in link |
| Change email | Confirm your new email address |
| Invite user | You're invited to Cannaplug |

The files use Supabase's `{{ .ConfirmationURL }}` variable and the same visual style as the app's emails.
