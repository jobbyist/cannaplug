/**
 * Every environment variable the app reads, grouped by feature. `src/test/env-registry.test.ts` fails if server code
 * starts reading a variable that is not listed here, so this file stays the single source for docs/release/env-matrix.md.
 * status: "required" = the site breaks without it; "feature" = the named feature is off until it is set;
 * "optional" = has a safe default; "retiring" = being removed (none at present: Yoco was removed on 23 Oct 2026).
 */
export type EnvStatus = "required" | "feature" | "optional" | "retiring";
export type EnvVar = { name: string; group: string; status: EnvStatus; note: string };

export const ENV_VARS: EnvVar[] = [
  { name: "SUPABASE_URL", group: "Supabase", status: "required", note: "Server-side Supabase URL" },
  {
    name: "SUPABASE_PUBLISHABLE_KEY",
    group: "Supabase",
    status: "required",
    note: "Server-side anon key",
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    group: "Supabase",
    status: "required",
    note: "Server only; never VITE_",
  },
  {
    name: "VITE_SUPABASE_URL",
    group: "Supabase",
    status: "required",
    note: "Browser Supabase URL",
  },
  {
    name: "VITE_SUPABASE_PUBLISHABLE_KEY",
    group: "Supabase",
    status: "required",
    note: "Browser anon key",
  },
  {
    name: "SITE_URL",
    group: "Site",
    status: "required",
    note: "https://cannaplug012.co.za (payment return URLs)",
  },
  {
    name: "PUBLIC_APP_URL",
    group: "Site",
    status: "required",
    note: "Links in emails and document QR codes",
  },
  {
    name: "CONTACT_INBOX",
    group: "Site",
    status: "optional",
    note: "Default info@cannaplug012.co.za",
  },
  {
    name: "LOVABLE_CRON_SECRET",
    group: "Cron",
    status: "required",
    note: "Bearer for /api/public/* jobs; same value as GitHub secret CRON_SECRET",
  },
  {
    name: "LOVABLE_CRON_SECRET_PREVIOUS",
    group: "Cron",
    status: "optional",
    note: "Only during secret rotation",
  },
  {
    name: "RESEND_API_KEY",
    group: "Email",
    status: "feature",
    note: "All email; nothing is sent without it",
  },
  {
    name: "NOTIFY_FROM_EMAIL",
    group: "Email",
    status: "optional",
    note: "Default Cannaplug Support <admin@cannaplug012.co.za>",
  },
  {
    name: "NOTIFY_FROM_FALLBACK",
    group: "Email",
    status: "optional",
    note: "Used only while the main domain is unverified in Resend; default Cannaplug Support <admin@updates.cannaplug012.co.za>; 'none' disables",
  },
  {
    name: "NOTIFY_REPLY_TO",
    group: "Email",
    status: "optional",
    note: "Default admin@cannaplug012.co.za",
  },
  {
    name: "DOCUMENT_EMAIL_FROM",
    group: "Email",
    status: "optional",
    note: "Sender for clinical document links",
  },
  {
    name: "PAYPAL_CLIENT_ID",
    group: "PayPal",
    status: "feature",
    note: "PayPal hidden at checkout until all PayPal vars are set",
  },
  { name: "PAYPAL_CLIENT_SECRET", group: "PayPal", status: "feature", note: "" },
  {
    name: "PAYPAL_WEBHOOK_ID",
    group: "PayPal",
    status: "feature",
    note: "Webhook …/api/public/payments/paypal-webhook",
  },
  {
    name: "PAYPAL_MERCHANT_ID",
    group: "PayPal",
    status: "feature",
    note: "Compared on every capture",
  },
  { name: "PAYPAL_ENV", group: "PayPal", status: "feature", note: "sandbox or live" },
  { name: "PAYPAL_API_BASE", group: "PayPal", status: "optional", note: "Tests only" },
  {
    name: "PAYFAST_MERCHANT_ID",
    group: "PayFast",
    status: "feature",
    note: "Card / Instant EFT in rand; compared on every ITN",
  },
  {
    name: "PAYFAST_MERCHANT_KEY",
    group: "PayFast",
    status: "feature",
    note: "From the PayFast dashboard",
  },
  {
    name: "PAYFAST_PASSPHRASE",
    group: "PayFast",
    status: "feature",
    note: "Must match Settings → Developer settings in PayFast",
  },
  {
    name: "PAYFAST_ENV",
    group: "PayFast",
    status: "optional",
    note: "live (default) or sandbox; ITN …/api/public/payments/payfast-itn",
  },
  {
    name: "DELIVERY_ENABLED",
    group: "Checkout",
    status: "optional",
    note: "Online orders are pickup only until this is exactly true; set it when delivery is approved",
  },
  {
    name: "PAYFAST_API_BASE",
    group: "PayFast",
    status: "optional",
    note: "Tests only (localhost mock)",
  },
  { name: "GEMINI_API_KEY", group: "AI", status: "feature", note: "Chatbot and Journal" },
  {
    name: "GEMINI_CHAT_MODEL",
    group: "AI",
    status: "optional",
    note: "Default gemini-2.5-flash; falls back to -lite",
  },
  {
    name: "CHAT_MEMBER_RPD",
    group: "AI",
    status: "optional",
    note: "Messages per member per day, default 20",
  },
  { name: "GEMINI_RPM_LIMIT", group: "AI", status: "optional", note: "Default 8" },
  { name: "GEMINI_RPD_LIMIT", group: "AI", status: "optional", note: "Default 180" },
  {
    name: "CHAT_RPD_LIMIT",
    group: "AI",
    status: "optional",
    note: "Default 140 (rest reserved for the Journal)",
  },
  { name: "FIRECRAWL_API_KEY", group: "Journal", status: "feature", note: "Journal research step" },
  {
    name: "UNSPLASH_ACCESS_KEY",
    group: "Journal",
    status: "optional",
    note: "Article cover photos",
  },
  {
    name: "SIGNATURE_ATTESTATION_SECRET",
    group: "Clinical",
    status: "feature",
    note: "Practitioner signing",
  },
  {
    name: "VERIFICATION_IP_SALT",
    group: "Clinical",
    status: "feature",
    note: "Hashes IPs on /verify and webhooks",
  },
  {
    name: "EXTERNAL_SIGNATURE_API_URL",
    group: "Clinical",
    status: "optional",
    note: "External signature provider (not yet chosen)",
  },
  { name: "EXTERNAL_SIGNATURE_API_KEY", group: "Clinical", status: "optional", note: "" },
  { name: "EXTERNAL_SIGNATURE_WEBHOOK_SECRET", group: "Clinical", status: "optional", note: "" },
  {
    name: "TWILIO_ACCOUNT_SID",
    group: "SMS/WhatsApp",
    status: "optional",
    note: "Also set payment_settings.sms_enabled",
  },
  { name: "TWILIO_AUTH_TOKEN", group: "SMS/WhatsApp", status: "optional", note: "" },
  { name: "TWILIO_SMS_FROM", group: "SMS/WhatsApp", status: "optional", note: "" },
  { name: "TWILIO_WHATSAPP_FROM", group: "SMS/WhatsApp", status: "optional", note: "" },
  {
    name: "TEST_DATABASE_URL",
    group: "Tests",
    status: "optional",
    note: "Local real-Postgres tests only",
  },
  {
    name: "SENTRY_DSN",
    group: "Site",
    status: "optional",
    note: "Error monitoring (server side, scrubbed); off when unset",
  },
  {
    name: "VERCEL_ENV",
    group: "Site",
    status: "optional",
    note: "Set by Vercel; labels monitoring events by environment",
  },
  {
    name: "VERCEL_GIT_COMMIT_SHA",
    group: "Site",
    status: "optional",
    note: "Set by Vercel; release tag on monitoring events",
  },
];
