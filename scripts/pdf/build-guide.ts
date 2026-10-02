// bun scripts/pdf/build-guide.ts  ->  docs/Cannaplug-Platform-Guide.pdf  (+ docs/guide/guide.html)
// Screens come from scripts/pdf/capture-screens.ts. Fonts are embedded (Montserrat + Inter) so the PDF matches the site.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium } from "@playwright/test";

const root = new URL("../../", import.meta.url).pathname;
const b64 = (f: string) => readFileSync(root + f).toString("base64");
const font = (family: string, file: string) =>
  `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${b64(file)}) format('woff2');font-weight:100 900;font-style:normal}`;
const img = (name: string) => {
  const p = `docs/guide/screens/${name}.jpg`;
  return existsSync(root + p) ? `data:image/jpeg;base64,${b64(p)}` : "";
};
const logo = `data:image/png;base64,${b64("src/assets/cannaplug-logo-white.png")}`;
const logoDark = `data:image/png;base64,${b64("src/assets/cannaplug-logo.png")}`;

const VERSION = "Release candidate 1";
const DATE = new Date().toLocaleDateString("en-ZA", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

let figN = 0;
const fig = (name: string, caption: string, steps: string[] = []) => {
  const src = img(name);
  if (!src) return "";
  figN++;
  return `<figure><div class="frame"><img src="${src}" alt=""></div><figcaption><b>Figure ${figN}.</b> ${caption}</figcaption>${steps.length ? `<ol class="steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol>` : ""}</figure>`;
};
const callout = (kind: "tip" | "note" | "warn", title: string, body: string) =>
  `<div class="callout ${kind}"><b>${title}</b><p>${body}</p></div>`;
const table = (head: string[], rows: string[][]) =>
  `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

const chapters: { id: string; title: string; lead: string; html: string }[] = [];
const chapter = (id: string, title: string, lead: string, html: string) =>
  chapters.push({ id, title, lead, html });

// ------------------------------------------------------------------------------------------------
chapter(
  "start",
  "Welcome to the platform",
  "One system for the shop, the till, the member, the practitioner and the back office.",
  `<p>Cannaplug connects everything a dispensary needs: a storefront customers love, an account where members follow their orders and rewards, a till and back office for the team, and a secure portal for practitioners. This guide explains every part, step by step. Find your role below and jump to that chapter.</p>
${table(
  ["You are…", "Start here", "What you can do"],
  [
    [
      "A <b>visitor or member</b>",
      "Chapters 2–4",
      "Browse the shop and Journal, ask the chatbot, verify your ID, order, pay, track orders, earn rewards",
    ],
    [
      "A <b>budtender</b>",
      "Chapter 5",
      "Run the till (cash, card, EFT), fulfil online orders, check stock",
    ],
    [
      "A <b>manager</b>",
      "Chapter 5",
      "Everything a budtender does, plus payments and EFT approval, ID reviews, stock, products, voids/refunds, audit log",
    ],
    [
      "An <b>administrator</b>",
      "Chapters 5–6",
      "Everything above, plus staff roles, practitioners and the clinical document policies",
    ],
    [
      "A <b>doctor / practitioner</b>",
      "Chapter 6",
      "Receive member requests, write and sign medical letters and prescriptions",
    ],
  ],
)}
${callout("tip", "How this guide is organised", "Each chapter starts with what the screen is for, then numbered steps, then what to do if something looks wrong. Screenshots show the real application with demonstration data.")}
<h3>The platform at a glance</h3>
${table(
  ["Area", "Highlights"],
  [
    [
      "Storefront",
      "Shop, menu, events, Journal (new article every morning), FAQ, contact form, newsletter, <b>Ask Cannaplug</b> AI assistant",
    ],
    [
      "Member portal",
      "ID verification, live order tracking, Pay now, reorder, rewards &amp; tiers, addresses, saved products with back-in-stock alerts",
    ],
    [
      "Checkout &amp; payments",
      "EFT, card or Instant EFT (Yoco), PayPal; an order is confirmed only after the payment is <i>verified</i>",
    ],
    [
      "Admin dashboard",
      "Overview, POS, orders, payments, products, inventory, customers, ID checks, clinical documents, deliveries, audit log",
    ],
    [
      "Doctor portal",
      "Patients, requests, medical letters, prescriptions, templates, signatures, QR verification",
    ],
    [
      "Automation",
      "Order, payment, ID, stock and newsletter emails; scheduled jobs; daily Journal article at 06:00",
    ],
  ],
)}`,
);

chapter(
  "store",
  "The storefront",
  "What every visitor sees — and how to get help.",
  `${fig("public-home", "The home page: shop, menu, events, Journal and contact in one scroll.")}
<h3>Shop and menu</h3>
<p>The <b>Shop</b> lists every product that is available to order online, with live prices. Use the filters for category, strain type and price. Tap <b>Add</b> to put an item in your cart; the cart button at the top right shows how many items you have.</p>
${fig("public-shop", "The shop with category filters and live prices.")}
<h3>The Journal</h3>
<p>The Journal publishes stories on South African cannabis culture. A new article is published automatically every morning at <b>06:00 (SAST)</b>. Subscribers receive a weekly digest on Thursdays.</p>
${fig("public-journal", "The Journal index.")}
<h3>Contact, newsletter and the FAQ</h3>
<p>The contact form on the home page sends your message to <b>info@cannaplug012.co.za</b> and emails you a confirmation. The footer newsletter box asks for your email, records your consent and sends a welcome message with a one-click <i>unsubscribe</i> link. The FAQ answers common questions about ordering, delivery and accounts.</p>
${fig("public-contact", "Contact details, the store video and the contact form.")}
<h3>Ask Cannaplug — the AI assistant</h3>
<p>The green tab on the right opens a chat with <b>Ask Cannaplug</b>. It knows our hours, delivery options, payment methods, refund rules, rewards and the current menu.</p>
${fig("public-chat", "The Ask Cannaplug chat panel.")}
${callout("note", "What the assistant will not do", "It never gives medical, dosing or treatment advice, cannot see your orders or account, never asks for ID numbers, card details or passwords, and never confirms that a payment has gone through. For anything personal it points you to your account or the team. To keep the service free for everyone it limits each visitor to a few messages per hour; if you see “busy”, try again in a minute.")}`,
);

chapter(
  "member",
  "The member portal",
  "Sign up once, verify your ID once, then order whenever you like.",
  `<h3>1. Create your account and verify your ID</h3>
${fig("member-signin", "Sign in or create an account at <b>/account</b>.", ["Choose <b>Create account</b> and enter your name, email, date of birth and a password. You must be 18 or older.", "Confirm your email using the message we send.", "Open <b>ID Verification</b> and upload a clear photo of your ID (South African ID, passport or driver’s licence). Passports and licences also need an expiry date.", "Our team reviews it — usually within one business day — and emails you the result."])}
${fig("member-id", "ID Verification shows where you are: not started, in review, verified, or rejected with the reason.")}
${callout("note", "Your ID and privacy", "Your ID image is stored privately, shown only to authorised reviewers (every view is logged), and kept for as long as your account exists. South African IDs never expire; passports and licences are re-checked when they expire — we email you 30 days before.")}
<h3>2. Your dashboard</h3>
${fig("member-dashboard", "The dashboard: orders, total spent, rewards points, recent orders and recommendations.")}
<h3>3. Orders — live</h3>
<p>Every order appears here and updates by itself — no need to refresh. The timeline shows <b>Awaiting payment → Confirmed → Packing → Ready → Out for delivery → Completed</b>.</p>
${fig("member-orders", "Order history with live status. Unpaid orders show <b>Pay now</b> and a points-redemption control.", ["Open <b>Orders</b>.", "For an unpaid order choose <b>Pay now</b> (card / Instant EFT or PayPal) or pay by EFT using your order number as the reference.", "Use <b>Reorder</b> to rebuy a past order — prices and stock are re-checked first."])}
<h3>4. Rewards &amp; loyalty</h3>
<p>You earn <b>1 point for every R10</b> you spend, online or in store. Your lifetime points move you up the tiers (Seed, Sprout, Bloom, Canopy). Redeem points against an unpaid order from the Orders tab.</p>
${fig("member-rewards", "Points balance, tier progress and history.")}
<h3>5. Addresses, saved products, settings</h3>
${fig("member-addresses", "Save up to 10 delivery addresses and choose a default.")}
${fig("member-saved", "Save products. If one is out of stock, tap <b>Notify me</b> and we email you when it returns.")}
${fig("member-settings", "Account settings.")}`,
);

chapter(
  "checkout",
  "Checkout and payment",
  "Three ways to pay — and one rule: an order is paid only when the payment is verified.",
  `${fig("checkout-payment", "Step 4 of checkout: choose how to pay.")}
${table(
  ["Method", "How it works", "When is the order confirmed?"],
  [
    [
      "<b>EFT / bank transfer</b>",
      "Place the order; we hold your items for 2 hours. Pay by EFT using the <b>order number as the reference</b>.",
      "When a manager verifies the payment in the bank account (amounts of R10,000 or more need a second manager).",
    ],
    [
      "<b>Card or Instant EFT (Yoco)</b>",
      "You are taken to Yoco’s secure page and return afterwards.",
      "Automatically, when Yoco’s signed confirmation reaches us and the amount matches.",
    ],
    [
      "<b>PayPal</b>",
      "PayPal charges in US dollars. We convert your rand total at today’s market rate plus a small conversion margin, and PayPal shows the exact amount before you pay.",
      "Automatically, when PayPal confirms the capture and the amount matches.",
    ],
  ],
)}
${callout("warn", "Returning to the site is not payment", "After paying you land on a confirmation page that keeps checking with the payment provider. That page never decides whether you have paid. If the confirmation takes a few minutes, do not pay again — the order will update on its own and we will email you.")}
<h3>If something goes wrong</h3>
${table(
  ["What you see", "What it means", "What to do"],
  [
    [
      "“Confirming your payment…” for a while",
      "The provider has not confirmed yet",
      "Wait; you will get an email. Do not pay twice.",
    ],
    [
      "Order still “Awaiting payment” after you paid",
      "The payment did not match (amount/reference) or is delayed",
      "Contact info@cannaplug012.co.za with your order number; a manager checks the Payments screen",
    ],
    [
      "“PayPal is temporarily unavailable”",
      "The exchange rate could not be fetched",
      "Pay by card or EFT instead",
    ],
    [
      "Your hold expired",
      "Unpaid orders keep stock for a short time",
      "Place the order again; if you already paid we refund or reinstate",
    ],
  ],
)}`,
);

chapter(
  "admin",
  "The admin dashboard",
  "Everything the team needs, in one place. Open it at /admin.",
  `<p>The sidebar shows the sections your role may use. Budtenders see the till and fulfilment; managers see money, stock and people; administrators also manage roles and practitioners.</p>
${table(
  ["Section", "Budtender", "Manager", "Admin"],
  [
    ["Overview, Orders, Deliveries, Customers (view)", "✔", "✔", "✔"],
    ["POS — open/close till, sell (cash, card, EFT)", "✔", "✔", "✔"],
    ["POS — review till variance, void or refund a sale", "—", "✔", "✔"],
    ["Stock — receive, adjust, batches", "—", "✔", "✔"],
    ["Products — create, edit, price, deactivate", "—", "✔", "✔"],
    ["Payments — EFT confirm, approve, FX rate", "—", "✔", "✔"],
    ["ID Checks — review and decide", "—", "✔", "✔"],
    ["Audit log", "—", "✔", "✔"],
    ["Roles, practitioners, signature policy", "—", "—", "✔"],
  ],
)}
${fig("admin-overview", "Overview: today’s sales, recent orders, stock and activity.")}
<h3>Orders and deliveries</h3>
${fig("admin-orders", "The Orders list. Click a row to open the order.")}
${fig("admin-order-detail", "Order detail: delivery and contact details, items, totals and the next allowed steps.", ["Open <b>Orders</b> and click the order.", "For an unpaid EFT order use <b>Confirm EFT received</b> (managers) — see Payments below. The plain <i>Confirmed</i> button is deliberately not offered for unpaid orders.", "Use the next-step buttons: <b>Packing → Ready → Out for delivery → Completed</b>. Each change emails the member and is recorded in the audit log.", "<b>Cancelled</b> releases the held stock."])}
${fig("admin-deliveries", "Deliveries: confirmed, packing, ready and out-for-delivery orders.")}
<h3>POS — the till</h3>
<p>The till records in-store sales with cash, card or manual EFT — alone or split across several tenders. Card and EFT need a reference (4–100 characters) that can only be used once.</p>
${fig("admin-pos", "The POS screen.", ["Choose a drawer and <b>Open session</b> with the opening float.", "Add products; optionally pick the customer so loyalty points are earned.", "Choose tenders and amounts; for card/EFT enter the reference. Cash shows the change to hand back.", "<b>Complete sale</b>. At the end of the shift <b>Close session</b> and count the cash; a manager reviews any variance."])}
<h3>Payments (managers)</h3>
${fig("admin-payments", "Payments: provider status, PayPal exchange rate, items needing attention and every attempt.")}
<ul>
<li><b>Needs attention</b> lists payments that did not match what was expected (wrong amount, currency or reference) or that arrived for a cancelled or already-paid order. Nothing was applied automatically. Check the provider’s dashboard, then confirm the order through the EFT workflow if the money is genuine, or refund in the provider’s dashboard.</li>
<li><b>EFT approvals</b>: an EFT of R10,000 or more is recorded by one manager and approved by a <i>different</i> manager before the order is confirmed. You cannot approve your own entry.</li>
<li><b>PayPal exchange rate</b>: live by default (two sources must agree), with a 4% margin to cover PayPal’s conversion spread. You can change the margin or set a manual rate for 24 hours.</li>
</ul>
<h3>Products and inventory</h3>
${fig("admin-products", "Products: create and edit items, set prices, deactivate.")}
${fig("admin-inventory", "Inventory: available = on hand minus stock held for unpaid online orders. Receive and adjust stock from the POS stock-control screen.")}
<h3>Customers and ID checks</h3>
${fig("admin-customers", "Customers.")}
${fig("admin-idchecks", "ID Checks: the review queue.", ["Open <b>ID Checks</b> (managers only).", "Choose a member and <b>View document</b> — this is logged before the image is shown.", "Tick the confirmation, then <b>Approve</b>, or <b>Reject</b> with a reason the member will see.", "The member is emailed and their open page updates live."])}
<h3>Clinical documents</h3>
${fig("admin-clinical", "Clinical Docs (administrators): practitioners, patients, requests, signature policy and the audit trail.")}
<h3>Audit log</h3>
${fig("admin-audit", "Every staff and till action, with who did it. Entries cannot be edited or deleted.")}
${callout("tip", "Behind the scenes", "Emails and SMS are queued and sent by a scheduled job every 5 minutes; stock holds, loyalty retries, ID reminders and the weekly digest run hourly; a new Journal article is published daily at 06:00 SAST. Administrators can see the schedule in the runbook.")}`,
);

chapter(
  "doctor",
  "The doctor portal",
  "Requests in, signed documents out — with every step recorded.",
  `<p>Practitioners sign in with their own account at <b>/doctor</b>. An administrator verifies their registration number and links patients to them; only then can they issue documents.</p>
${fig("doctor-home", "The practitioner overview: new requests, items awaiting review, drafts, issued documents and patients.")}
<h3>Daily workflow</h3>
${fig("doctor-patients", "Patients linked to you.", ["Open <b>Requests</b>: members can ask for a medical letter or prescription from their account.", "<b>Accept</b> a request or <b>decline</b> it with a reason.", "Choose <b>New medical letter</b> or <b>New prescription</b> from a template approved for your practice.", "Fill the clinical fields yourself — nothing clinical is ever pre-filled or suggested by the system.", "Submit for review, review the final text, then <b>Sign</b>."])}
${fig("doctor-documents", "Documents: drafts, awaiting review, issued, expired, revoked.")}
${fig("doctor-templates", "Templates: versioned wording that you approve before it can be used.")}
<h3>Verification and safeguards</h3>
<ul>
<li>Every issued document carries a <b>QR code and verification link</b> (<i>/verify</i>). The public page confirms whether the document is valid — it never reveals clinical content.</li>
<li>Documents can be <b>voided</b> or <b>revoked</b> with a reason; expired documents are marked automatically.</li>
<li>Signatures follow the signature policy set by an administrator; a signature image can never be reused.</li>
<li>The assistant chatbot and the content tools have no access to any clinical data.</li>
</ul>`,
);

chapter(
  "touch",
  "Emails and other touchpoints",
  "Every automatic message, who gets it and what triggers it.",
  `<p>Messages are sent from <b>Cannaplug Support &lt;updates@cannaplug.co.za&gt;</b>. They are queued first and retried automatically, so a temporary outage never loses a message.</p>
${table(
  ["Message", "Recipient", "Triggered by"],
  [
    ["Welcome", "New member", "Account created"],
    ["ID received / approved / rejected", "Member", "ID submitted, reviewed"],
    ["ID expiring", "Member", "30 days before a passport or licence expires"],
    [
      "Order received, payment confirmed, ready, out for delivery, completed, cancelled",
      "Member",
      "Each order status change",
    ],
    ["Back in stock", "Member", "A saved product becomes available"],
    ["Contact form acknowledgement", "Sender", "Contact form submitted"],
    [
      "Newsletter welcome; weekly Journal digest",
      "Subscribers",
      "Subscribing; every Thursday (consenting subscribers only, one-click unsubscribe)",
    ],
    [
      "New order; ID waiting for review; payment needs review; refund needed; EFT awaiting approval; low stock",
      "Managers",
      "The matching event",
    ],
    [
      "Website message",
      "info@cannaplug012.co.za",
      "Contact form (reply goes straight to the sender)",
    ],
  ],
)}
<h3>Other touchpoints</h3>
<ul>
<li><b>Verification page</b> (<i>/verify/…</i>): public check of a clinical document’s validity.</li>
<li><b>Unsubscribe page</b> (<i>/unsubscribe</i>): one click from any marketing email.</li>
<li><b>Payment return page</b> (<i>/payment/return</i>): shows live payment status; never decides it.</li>
<li><b>Sign-in, password reset and confirmation emails</b> are branded and sent through the same sender.</li>
</ul>`,
);

chapter(
  "secure",
  "Security, privacy and compliance",
  "How the platform protects money, stock, people and records.",
  `${table(
    ["Protection", "What it means for you"],
    [
      [
        "Payments verified before they count",
        "Provider messages are signature-checked and compared with the expected amount, currency, merchant and order before anything is marked paid. Replays and duplicates change nothing.",
      ],
      [
        "Role-based access",
        "Every action is checked on the server against your role; the database refuses anything your role may not do.",
      ],
      ["Dual control for large EFTs", "Amounts of R10,000 or more need two different managers."],
      [
        "Tamper-evident audit log",
        "Till sales, order changes, role changes, ID decisions and payment steps are recorded with who did them and can never be edited.",
      ],
      [
        "Private ID storage",
        "ID images are never public, every view is logged, and they are removed if an account is deleted.",
      ],
      [
        "Browser hardening",
        "Strict content-security rules, HTTPS-only transport, no framing of clinical pages.",
      ],
      [
        "Chat and automation limits",
        "The assistant and the Journal share a usage budget that stays inside the free tier; counters live in the database.",
      ],
    ],
  )}
${callout("warn", "Compliance wording needs sign-off", "Statements about authorisations, registrations, lab testing, banking details and policies appear on the site and in this product. Before launch each one must be approved by the client and backed by a document (see the compliance register in the repository). Until then the release check blocks.")}
<h3>Troubleshooting</h3>
${table(
  ["Problem", "Try this"],
  [
    [
      "I cannot see a section in the admin sidebar",
      "Your role does not include it; ask an administrator.",
    ],
    [
      "A member says they never got an email",
      "Check <i>notification_events</i> for the address; see the runbook for dead-lettered messages.",
    ],
    [
      "The PayPal button is missing",
      "The exchange rate is unavailable or PayPal is not configured; Payments shows the status.",
    ],
    [
      "The chatbot says it is busy",
      "The shared usage budget is used up for now; it recovers each minute / day.",
    ],
    [
      "No new Journal article today",
      "The daily job may be paused (rejected API key) or a duplicate was skipped; see the runbook.",
    ],
  ],
)}`,
);

// ------------------------------------------------------------------------------------------------
const toc = chapters
  .map(
    (c, i) =>
      `<li><a href="#${c.id}"><span class="n">${i + 1}</span><span class="t">${c.title}</span></a></li>`,
  )
  .join("");
const css = `
${font("Montserrat", "node_modules/@fontsource-variable/montserrat/files/montserrat-latin-wght-normal.woff2")}
${font("Inter", "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2")}
:root{--green:#17432b;--deep:#0d2a1a;--accent:#2db35e;--bg:#f6faf6;--ink:#14201a;--muted:#5d6b63;--gold:#c9a64a;--line:#dfe9e1;--sage:#dbe8dd}
*{box-sizing:border-box}
@page{size:A4;margin:18mm 16mm 20mm 16mm}
@page :first{margin:0}
html{font-family:'Inter',Arial,sans-serif;color:var(--ink);font-size:10.4pt;line-height:1.55}
body{margin:0;background:#fff}
h1,h2,h3{font-family:'Montserrat',Arial,sans-serif;color:var(--green);margin:0}
h2{font-size:21pt;font-weight:800;text-transform:uppercase;letter-spacing:.01em;line-height:1.12}
h3{font-size:12pt;font-weight:800;text-transform:uppercase;letter-spacing:.03em;margin:20px 0 6px;break-after:avoid}
p{margin:0 0 9px}
.cover{height:297mm;width:210mm;page-break-after:always;background:radial-gradient(1200px 700px at 90% -10%,#2a6a43 0%,transparent 60%),linear-gradient(160deg,var(--deep),var(--green));color:#fff;padding:26mm 22mm;position:relative;overflow:hidden}
.cover img.logo{height:15mm}
.cover .eyebrow{margin-top:70mm;font:700 10pt 'Montserrat';letter-spacing:.28em;text-transform:uppercase;color:#9fe0b6}
.cover h1{color:#fff;font-size:44pt;font-weight:800;line-height:1.02;text-transform:uppercase;margin-top:6mm}
.cover h1 em{font-style:normal;color:var(--accent)}
.cover p.sub{font-size:13pt;max-width:130mm;color:#d9eadf;margin-top:8mm}
.cover .meta{position:absolute;left:22mm;bottom:22mm;font:600 9pt 'Montserrat';letter-spacing:.14em;text-transform:uppercase;color:#bfe3cb}
.cover .leaf{position:absolute;right:-30mm;bottom:-30mm;width:150mm;height:150mm;border-radius:50%;border:1.2mm solid rgba(255,255,255,.08)}
.cover .leaf::after{content:"";position:absolute;inset:14mm;border-radius:50%;border:1.2mm solid rgba(255,255,255,.07)}
.toc{page-break-after:always}
.toc h2{margin-bottom:6mm}
.toc ol{list-style:none;padding:0;margin:0}
.toc li a{display:flex;gap:10px;align-items:baseline;text-decoration:none;color:var(--ink);padding:9px 0;border-bottom:1px solid var(--line)}
.toc .n{font:800 15pt 'Montserrat';color:var(--accent);width:26px}
.toc .t{font:700 11.5pt 'Montserrat';text-transform:uppercase;letter-spacing:.02em}
section.chapter{break-before:page}
.chead{border-bottom:3px solid var(--accent);padding-bottom:8px;margin-bottom:12px}
.chead .num{font:700 9pt 'Montserrat';letter-spacing:.24em;text-transform:uppercase;color:var(--accent)}
.lead{font-size:12pt;color:var(--muted);margin:6px 0 0}
table{width:100%;border-collapse:collapse;margin:8px 0 14px;font-size:9.4pt;break-inside:avoid}
th{background:var(--green);color:#fff;font:700 8.4pt 'Montserrat';letter-spacing:.06em;text-transform:uppercase;text-align:left;padding:7px 9px}
td{padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
tr:nth-child(even) td{background:var(--bg)}
figure{margin:12px 0 16px;break-inside:avoid}
.frame{width:92%;margin:0 auto;border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:0 8px 24px rgba(23,67,43,.10);background:#fff}
.frame img{display:block;width:100%}
figcaption{font-size:8.8pt;color:var(--muted);margin-top:6px;width:92%;margin-left:auto;margin-right:auto}
.steps{width:92%;margin-left:auto !important;margin-right:auto !important}
.steps{margin:8px 0 0;padding-left:0;list-style:none;counter-reset:s}
.steps li{counter-increment:s;position:relative;padding:3px 0 3px 30px;font-size:9.6pt}
.steps li::before{content:counter(s);position:absolute;left:0;top:2px;width:20px;height:20px;border-radius:50%;background:var(--accent);color:#fff;font:800 8.5pt 'Montserrat';display:grid;place-items:center}
.callout{border-left:4px solid var(--accent);background:var(--bg);border-radius:0 10px 10px 0;padding:9px 13px;margin:12px 0;break-inside:avoid}
.callout b{font:800 8.6pt 'Montserrat';letter-spacing:.08em;text-transform:uppercase;color:var(--green)}
.callout p{margin:3px 0 0;font-size:9.6pt}
.callout.warn{border-color:var(--gold);background:#fbf6e8}
.callout.warn b{color:#8a6d1c}
.callout.note{border-color:#7aa88a}
ul{margin:6px 0 10px;padding-left:18px} li{margin:2px 0}
.back{page-break-before:always;background:var(--green);color:#fff;padding:30mm 20mm;height:240mm;border-radius:6px}
.back h2{color:#fff} .back p{color:#d9eadf}
`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cannaplug Platform Guide</title><style>${css}</style></head><body>
<div class="cover"><img class="logo" src="${logo}" alt="Cannaplug"><div class="eyebrow">Platform guide</div><h1>Everything<br>you need to<br><em>run &amp; use</em><br>Cannaplug</h1><p class="sub">Storefront, member portal, admin dashboard, doctor portal and every automatic touchpoint — explained step by step.</p><div class="meta">${VERSION} · ${DATE}</div><div class="leaf"></div></div>
<div class="toc"><h2>Contents</h2><ol>${toc}</ol></div>
${chapters.map((c, i) => `<section class="chapter" id="${c.id}"><div class="chead"><div class="num">Chapter ${i + 1}</div><h2>${c.title}</h2><p class="lead">${c.lead}</p></div>${c.html}</section>`).join("")}
<div class="back"><img src="${logo}" style="height:12mm" alt=""><h2 style="margin-top:20mm">Need a hand?</h2><p>Email <b>info@cannaplug012.co.za</b> · Pretoria Central · Mon–Fri 09:00–19:00, Sat 09:00–20:00, Sun 09:00–15:00.</p><p>For technical operations — deployments, schedules, secrets, rollbacks — see the Release Runbook in the repository (docs/release).</p><p style="margin-top:14mm;font-size:8.5pt;opacity:.8">Screenshots use demonstration data. Wording on this site and in this guide that relates to authorisations, registrations, testing and legal terms is subject to client approval and documentary evidence before launch.</p></div>
</body></html>`;
writeFileSync(root + "docs/guide/guide.html", html);
const browser = await chromium.launch({
  executablePath: process.env["PLAYWRIGHT_CHROMIUM_PATH"] ?? "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "load" });
await page.pdf({
  path: root + "docs/Cannaplug-Platform-Guide.pdf",
  format: "A4",
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: `<div style="width:100%;font:600 7pt Arial;letter-spacing:.14em;text-transform:uppercase;color:#5d6b63;padding:0 16mm;display:flex;justify-content:space-between"><span>Cannaplug · Platform guide</span><span>${VERSION}</span></div>`,
  footerTemplate: `<div style="width:100%;font:600 7pt Arial;color:#5d6b63;padding:0 16mm;display:flex;justify-content:space-between"><span>info@cannaplug012.co.za</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
  margin: { top: "18mm", bottom: "20mm", left: "16mm", right: "16mm" },
});
await browser.close();
console.log("wrote docs/Cannaplug-Platform-Guide.pdf");
