// RESEND_API_KEY=re_... bun scripts/send-test-emails.ts you@example.com [template ...]
// Sends every template (or the named ones) as "[TEST] ..." from the app's sender (Cannaplug Support
// <admin@cannaplug012.co.za>, falling back to admin@updates.cannaplug012.co.za while the main domain is unverified).
// Use the SAME Resend account/key that the app uses.
import { renderAll } from "./email-samples";
import { sendWithResend, senderFromEnv } from "../src/lib/email/sender";

const [to, ...only] = process.argv.slice(2);
const key = process.env["RESEND_API_KEY"];
if (!to || !key) {
  console.error("usage: RESEND_API_KEY=... bun scripts/send-test-emails.ts <to> [template...]");
  process.exit(1);
}
const sender = senderFromEnv(process.env);
let failed = 0;
for (const { name, rendered } of renderAll().filter((a) => !only.length || only.includes(a.name))) {
  const res = await sendWithResend(
    (u, i) => fetch(u, i),
    key,
    sender,
    {
      to: [to],
      subject: `[TEST] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
      ...(rendered.headers ? { headers: rendered.headers } : {}),
    },
    `test-${name}-${Date.now()}`,
  );
  const ok = res.status >= 200 && res.status < 300;
  console.log(
    `${ok ? "sent  " : "FAILED"} ${name.padEnd(24)} ${ok ? `from ${res.from}` : `${res.status} ${res.body.slice(0, 160)}`}`,
  );
  if (!ok) failed++;
  await new Promise((r) => setTimeout(r, 1200)); // stay under Resend's 2 requests/second (a fallback is 2 calls)
}
process.exit(failed ? 1 : 0);
