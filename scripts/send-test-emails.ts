// RESEND_API_KEY=re_... bun scripts/send-test-emails.ts you@example.com [template ...]
// Sends every template (or the named ones) as "[TEST] ..." from "Cannaplug Support <updates@cannaplug.co.za>".
// Use the SAME Resend account/key that the app uses, and make sure cannaplug.co.za is verified in it.
import { renderAll } from "./email-samples";

const [to, ...only] = process.argv.slice(2);
const key = process.env["RESEND_API_KEY"];
if (!to || !key) {
  console.error("usage: RESEND_API_KEY=... bun scripts/send-test-emails.ts <to> [template...]");
  process.exit(1);
}
const from = process.env["NOTIFY_FROM_EMAIL"] ?? "Cannaplug Support <updates@cannaplug.co.za>";
let failed = 0;
for (const { name, rendered } of renderAll().filter((a) => !only.length || only.includes(a.name))) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `test-${name}-${Date.now()}` },
    body: JSON.stringify({ from, to: [to], subject: `[TEST] ${rendered.subject}`, html: rendered.html, text: rendered.text, ...(rendered.headers ? { headers: rendered.headers } : {}) }),
  });
  const body = await res.text();
  console.log(`${res.ok ? "sent  " : "FAILED"} ${name.padEnd(24)} ${res.ok ? "" : `${res.status} ${body.slice(0, 160)}`}`);
  if (!res.ok) failed++;
  await new Promise((r) => setTimeout(r, 600)); // stay under Resend's 2 requests/second
}
process.exit(failed ? 1 : 0);
