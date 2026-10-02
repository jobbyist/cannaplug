// bun scripts/render-email-previews.ts  ->  docs/email-previews/*.html + index.html
import { mkdirSync, writeFileSync } from "node:fs";
import { renderAll } from "./email-samples";

const dir = new URL("../docs/email-previews/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const all = renderAll();
for (const { name, rendered } of all) writeFileSync(`${dir}${name}.html`, rendered.html);
const staff = all.filter((a) => a.name.startsWith("staff_") || a.name === "contact_form_staff");
const member = all.filter((a) => !staff.includes(a));
const li = (a: (typeof all)[number]) =>
  `<li><a href="${a.name}.html"><b>${a.name}</b></a> — ${a.rendered.subject.replace(/</g, "&lt;")}</li>`;
writeFileSync(
  `${dir}index.html`,
  `<!doctype html><meta charset="utf-8"><title>Cannaplug email previews</title><body style="font-family:Inter,Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#14201a"><h1>Cannaplug email templates</h1><h2>Members &amp; subscribers (${member.length})</h2><ul>${member.map(li).join("")}</ul><h2>Staff (${staff.length})</h2><ul>${staff.map(li).join("")}</ul></body>`,
);
console.log(`rendered ${all.length} templates to docs/email-previews/`);
