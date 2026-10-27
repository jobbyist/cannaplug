/**
 * Notification templates. Pure functions of (template id, queued data): no I/O, so they are trivially
 * testable and are never rendered on a UI path — only the dispatcher calls them, after claiming a queued row.
 * Every interpolated value is HTML-escaped. Visual language follows the site: deep green header,
 * Montserrat headings, off-white card, gold accent for compliance notes.
 */
export interface Rendered {
  subject: string;
  /** Where a reply should go (e.g. the person who filled in the contact form). */
  replyTo?: string;
  /** Extra message headers (e.g. List-Unsubscribe on marketing mail). */
  headers?: Record<string, string>;
  html: string;
  text: string;
  /** Short text for SMS / WhatsApp, if this template has one. */
  sms?: string;
}

export type TemplateData = Record<string, unknown>;

const esc = (v: unknown): string =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const rand = (v: unknown) =>
  `R${Number(v ?? 0)
    .toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/\u00a0/g, " ")}`;

export const BRAND = {
  name: "Cannaplug",
  // Design tokens: Forest, Leaf, Gold, Cream.
  green: "#0B3D20",
  accent: "#16A34A",
  gold: "#D4AF37",
  bg: "#F8FAF8",
  ink: "#14201a",
  muted: "#5d6b63",
  supportEmail: "admin@cannaplug012.co.za",
  legal: "CANNAPLUG PTY LTD",
  address: "Shop 002, One On Mutual, Pretoria Central",
  phone: "+27 68 291 2107",
  logoPath: "/email/cannaplug-logo-white.png",
} as const;

function layout(opts: {
  preheader: string;
  title: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
  footerNote?: string;
  /** Absolute site URL, used for the logo image. */
  siteUrl?: string;
}): string {
  const { preheader, title, bodyHtml, cta, footerNote } = opts;
  const base = (opts.siteUrl ?? "https://cannaplug012.co.za").replace(/\/+$/, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;background:${BRAND.bg};font-family:Inter,Arial,sans-serif;color:${BRAND.ink}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #dfe9e1;border-radius:14px;overflow:hidden">
<tr><td style="background:${BRAND.green};padding:22px 28px;border-bottom:4px solid ${BRAND.gold}"><a href="${base}/" style="text-decoration:none"><img src="${base}${BRAND.logoPath}" width="144" height="32" alt="${BRAND.name}" style="display:block;border:0;height:32px;width:144px;color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-weight:800;font-size:18px;letter-spacing:.12em;text-transform:uppercase"></a></td></tr>
<tr><td style="padding:28px">
<h1 style="font-family:Montserrat,Arial,sans-serif;font-size:21px;line-height:1.25;margin:0 0 14px;text-transform:uppercase;letter-spacing:.02em;color:${BRAND.green}">${esc(title)}</h1>
${bodyHtml}
${cta ? `<p style="margin:24px 0 4px"><a href="${esc(cta.url)}" style="background:${BRAND.accent};color:#ffffff;text-decoration:none;font-family:Montserrat,Arial,sans-serif;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:13px 24px;border-radius:999px;display:inline-block;font-size:13px">${esc(cta.label)}</a></p>` : ""}
</td></tr>
<tr><td style="padding:18px 28px;background:${BRAND.bg};color:${BRAND.muted};font-size:12px;line-height:1.55;border-top:1px solid #e3ece5">
${footerNote ? `<p style="margin:0 0 10px;border-left:3px solid ${BRAND.gold};padding-left:10px">${esc(footerNote)}</p>` : ""}
<p style="margin:0 0 6px">Questions? Reply to this email or write to <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.green};font-weight:600">${BRAND.supportEmail}</a>.</p>
<p style="margin:0">${BRAND.legal} · ${BRAND.address} · ${BRAND.phone}<br>For adults 18 and over. Please consume responsibly.</p>
</td></tr></table></td></tr></table></body></html>`;
}

const p = (s: string) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6">${s}</p>`;
const kv = (rows: [string, string][]) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 16px;border:1px solid #e3ece5;border-radius:10px">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:9px 14px;color:${BRAND.muted};font-size:13px;border-bottom:1px solid #eef3ef">${esc(k)}</td><td style="padding:9px 14px;font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid #eef3ef">${v}</td></tr>`,
    )
    .join("")}</table>`;

const strip = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/(p|tr|h1|table)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

type Ctx = { siteUrl: string };
type Template = (d: TemplateData, c: Ctx) => Omit<Rendered, "text"> & { text?: string };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const PICKUP_ADDRESS = "Shop 002, One On Mutual, Pretoria Central";
const orderRows = (d: TemplateData): [string, string][] => [
  ["Order", esc(d["order_number"])],
  ["Total", esc(rand(d["total_rand"]))],
  ...(d["delivery_method"] === "collection"
    ? ([["Collect at", PICKUP_ADDRESS]] as [string, string][])
    : []),
];
const accountUrl = (c: Ctx) => `${c.siteUrl.replace(/\/+$/, "")}/account`;
const adminUrl = (c: Ctx) => `${c.siteUrl.replace(/\/+$/, "")}/admin`;
const doctorUrl = (c: Ctx) => `${c.siteUrl.replace(/\/+$/, "")}/doctor`;
const documentsUrl = (c: Ctx) => `${c.siteUrl.replace(/\/+$/, "")}/member/documents`;
const CLINICAL_NOTE =
  "For your privacy, nothing from the document or request is included in this email.";
const hi = (d: TemplateData) => `Hi ${esc(String(d["contact_name"] ?? "there").split(" ")[0])},`;

export const TEMPLATES: Record<string, Template> = {
  order_received: (d, c) => {
    const eft = d["payment_method"] === "eft";
    return {
      subject: `We received your order ${d["order_number"]}`,
      html: layout({
        preheader: "Your items are held while we wait for payment.",
        title: "Order received",
        bodyHtml:
          p(hi(d)) +
          p(
            eft
              ? "Thanks for your order. We hold your items for 2 hours. Pay by EFT using your order number as the payment reference and we will confirm as soon as the payment clears."
              : "Thanks for your order. Complete your payment to secure your items — we hold them for a short time while you pay.",
          ) +
          kv(orderRows(d)),
        cta: { label: "View my order", url: accountUrl(c) },
        footerNote: "Your order is only confirmed once payment has been verified.",
      }),
    };
  },
  order_confirmed: (d, c) => ({
    subject: `Payment confirmed — order ${d["order_number"]}`,
    html: layout({
      preheader: "We have your payment and are preparing your order.",
      title: "Payment confirmed",
      bodyHtml:
        p(hi(d)) +
        p(
          d["delivery_method"] === "collection"
            ? "We have verified your payment and are preparing your order. We'll email you as soon as it is ready to collect at Shop 002, One On Mutual, Pretoria Central."
            : "We have verified your payment and are now preparing your order.",
        ) +
        kv(orderRows(d)),
      cta: { label: "Track my order", url: accountUrl(c) },
    }),
  }),
  order_ready: (d, c) => ({
    subject:
      d["delivery_method"] === "collection"
        ? `Your order ${d["order_number"]} is ready to collect`
        : `Your order ${d["order_number"]} is ready`,
    sms:
      d["delivery_method"] === "collection"
        ? `Cannaplug: order ${d["order_number"]} is ready to collect at Shop 002, One On Mutual. Bring your ID.`
        : `Cannaplug: order ${d["order_number"]} is ready.`,
    html: layout({
      preheader: "Your order is packed and ready.",
      title: "Your order is ready",
      bodyHtml:
        p(hi(d)) +
        p(
          d["delivery_method"] === "collection"
            ? `Your order is ready for collection at ${PICKUP_ADDRESS}. Bring a valid ID: we check it when you collect.`
            : "Your order is packed and will go out for delivery shortly.",
        ) +
        kv(orderRows(d)),
      cta: { label: "View my order", url: accountUrl(c) },
    }),
  }),
  order_out_for_delivery: (d, c) => ({
    subject: `Order ${d["order_number"]} is on its way`,
    sms: `Cannaplug: order ${d["order_number"]} is out for delivery. Please have your ID ready.`,
    html: layout({
      preheader: "Your delivery is on its way.",
      title: "Out for delivery",
      bodyHtml:
        p(hi(d)) +
        p("Your order is on its way. Please have your ID ready — we verify it on delivery.") +
        kv(orderRows(d)),
      cta: { label: "Track my order", url: accountUrl(c) },
    }),
  }),
  order_completed: (d, c) => ({
    subject: `Order ${d["order_number"]} completed`,
    html: layout({
      preheader: "Thank you for shopping with Cannaplug.",
      title: "Order completed",
      bodyHtml:
        p(hi(d)) +
        p(
          "Your order is complete. Thank you for shopping with us — your loyalty points have been added.",
        ) +
        kv(orderRows(d)),
      cta: { label: "See my points", url: accountUrl(c) },
    }),
  }),
  order_cancelled: (d, c) => ({
    subject: `Order ${d["order_number"]} cancelled`,
    html: layout({
      preheader: "Your order was cancelled.",
      title: "Order cancelled",
      bodyHtml:
        p(hi(d)) +
        p(
          "Your order has been cancelled and any stock held for it has been released. If you already paid, we will be in touch about your refund.",
        ) +
        kv(orderRows(d)),
      cta: { label: "Shop again", url: c.siteUrl },
    }),
  }),
  staff_new_order: (d, c) => ({
    subject: `New order ${d["order_number"]} — ${rand(d["total_rand"])}`,
    html: layout({
      preheader: "A new online order is awaiting payment.",
      title: "New online order",
      bodyHtml:
        p("A new online order has been placed and is awaiting payment.") +
        kv([
          ...orderRows(d),
          ["Payment", esc(d["payment_method"])],
          ["Delivery", esc(d["delivery_method"])],
        ]),
      cta: { label: "Open in admin", url: adminUrl(c) },
    }),
  }),
  staff_payment_review: (d, c) => ({
    subject: "Payment needs review",
    html: layout({
      preheader: "A payment could not be settled automatically.",
      title: "Payment needs review",
      bodyHtml:
        p(esc(d["reason"] ?? "A payment needs a person to look at it.")) +
        (d["transaction_id"] ? kv([["Transaction", esc(d["transaction_id"])]]) : ""),
      cta: { label: "Open payments", url: adminUrl(c) },
    }),
  }),
  contact_form_staff: (d) => ({
    subject: `Website message: ${String(d["subject"] ?? "").slice(0, 120)}`,
    ...(EMAIL_RE.test(String(d["email"] ?? "")) ? { replyTo: String(d["email"]) } : {}),
    html: layout({
      preheader: "A message from the website contact form.",
      title: "New website message",
      bodyHtml:
        kv([
          ["From", esc(d["name"])],
          ["Email", esc(d["email"])],
          ["Subject", esc(d["subject"])],
        ]) +
        `<p style="margin:0;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(d["message"])}</p>`,
      footerNote: "Reply to this email to answer the sender directly.",
    }),
  }),
  contact_form_ack: (d, c) => ({
    subject: "We received your message",
    html: layout({
      preheader: "Thanks for getting in touch.",
      title: "Thanks for getting in touch",
      bodyHtml:
        p(`Hi ${esc(String(d["name"] ?? "there").split(" ")[0])},`) +
        p(
          "We have received your message and a member of the team will reply as soon as they can — usually within one business day.",
        ) +
        kv([["Subject", esc(d["subject"])]]),
      cta: { label: "Visit Cannaplug", url: c.siteUrl },
    }),
  }),
  newsletter_welcome: (d, c) => ({
    subject: "Welcome to Cannaplug",
    html: layout({
      preheader: "You are on the list for stories, events and news.",
      title: "You're on the list",
      bodyHtml:
        p(
          "Thanks for subscribing. You will hear from us about new stories in the Journal, events and Cannaplug news.",
        ) +
        p(
          `Changed your mind? <a href="${esc(c.siteUrl.replace(/\/+$/, ""))}/unsubscribe?token=${esc(d["unsubscribe_token"])}" style="color:${BRAND.green}">Unsubscribe in one click</a>.`,
        ),
      cta: { label: "Read the Journal", url: `${c.siteUrl.replace(/\/+$/, "")}/journal` },
    }),
  }),
  member_welcome: (d, c) => ({
    subject: "Welcome to Cannaplug",
    html: layout({
      preheader: "Your account is ready — one quick step before you can order.",
      title: "Welcome to Cannaplug",
      bodyHtml:
        p(hi(d)) +
        p(
          "Your member account is ready. To order online we verify your ID once — upload it from your account and our team reviews it, usually within one business day.",
        ) +
        p(
          "Once you are verified you can order, track every order live, earn rewards points on every purchase and save your favourites.",
        ),
      cta: { label: "Verify my ID", url: accountUrl(c) },
      footerNote: "Cannaplug is for adults 18 and over.",
    }),
  }),
  id_submitted: (d, c) => ({
    subject: "We received your ID",
    html: layout({
      preheader: "Our team is reviewing it.",
      title: "ID received",
      bodyHtml:
        p(hi(d)) +
        p(
          "Thanks — we have your ID and our team will review it, usually within one business day. We will email you as soon as it is decided. You do not need to do anything else.",
        ),
      cta: { label: "Check my status", url: accountUrl(c) },
    }),
  }),
  id_approved: (d, c) => ({
    subject: "Your ID is verified — you can order now",
    html: layout({
      preheader: "You are all set.",
      title: "You're verified",
      bodyHtml:
        p(hi(d)) +
        p(
          "Your ID has been verified, so you can now order online." +
            (d["document_expires_on"]
              ? ` Your ID document expires on ${esc(d["document_expires_on"])} — we will remind you before then.`
              : " South African ID documents do not need to be re-verified."),
        ),
      cta: { label: "Start shopping", url: `${c.siteUrl.replace(/\/+$/, "")}/shop` },
    }),
  }),
  id_rejected: (d, c) => {
    const reasons: Record<string, string> = {
      unreadable: "the photo was too blurry or cut off to read",
      expired: "the document has expired",
      mismatch: "the details did not match the information on your account",
      underage: "you must be 18 or older to order",
      invalid_document: "that document type cannot be accepted",
    };
    const why = reasons[String(d["rejection_code"] ?? "")];
    return {
      subject: "We couldn't verify your ID",
      html: layout({
        preheader: "Here is how to fix it.",
        title: "We couldn't verify your ID",
        bodyHtml:
          p(hi(d)) +
          p(`We were not able to verify your ID${why ? ` because ${esc(why)}` : ""}.`) +
          p(
            "You can upload a new photo from your account and we will look again. If you think this is a mistake, reply to this email.",
          ),
        cta: { label: "Upload again", url: accountUrl(c) },
      }),
    };
  },
  id_expiring: (d, c) => ({
    subject: "Your ID document expires soon",
    html: layout({
      preheader: "Upload a new one to keep ordering.",
      title: "Your ID is expiring",
      bodyHtml:
        p(hi(d)) +
        p(
          `The ID document we verified expires on ${esc(d["document_expires_on"])}. To keep ordering without interruption, upload a current one from your account.`,
        ),
      cta: { label: "Update my ID", url: accountUrl(c) },
    }),
  }),
  back_in_stock: (d, c) => ({
    subject: `${String(d["product_name"] ?? "Your product")} is back in stock`,
    html: layout({
      preheader: "You asked us to tell you.",
      title: "Back in stock",
      bodyHtml:
        p(`Good news — <b>${esc(d["product_name"])}</b> is available again.`) +
        p("Stock moves quickly, so order soon if you want it."),
      cta: { label: "Shop now", url: `${c.siteUrl.replace(/\/+$/, "")}/shop` },
      footerNote: "You asked to be notified about this product; this is a one-time message.",
    }),
  }),
  staff_id_review: (d, c) => ({
    subject: "ID waiting for review",
    html: layout({
      preheader: "A member is waiting to order.",
      title: "ID waiting for review",
      bodyHtml: p(`${esc(d["member_name"] ?? "A member")} has submitted an ID for review.`),
      cta: { label: "Open ID checks", url: adminUrl(c) },
    }),
  }),
  // ID-check credits are running low (no member data: balances only).
  id_credits_low: (d, c) => {
    const available = Number(d["available"] ?? 0);
    const cost = Math.max(Number(d["cost_per_check"] ?? 3), 1);
    const checks = Math.max(Math.floor(available / cost), 0);
    return {
      subject:
        available <= 0
          ? "ID-check credits are used up: new sign-ups are paused"
          : "Top up your ID-check credits",
      html: layout({
        preheader:
          available <= 0
            ? "New members cannot sign up until credits are topped up."
            : `${available} credits left. Top up to avoid service disruption.`,
        title: available <= 0 ? "ID-check credits used up" : "ID-check credits running low",
        bodyHtml:
          p(
            available <= 0
              ? "New sign-ups and ID uploads are paused until credits are topped up."
              : "Please top up your ID-check credits to avoid service disruption.",
          ) +
          kv([
            ["Credits available", esc(available)],
            ["New-member checks left", esc(checks)],
            ["Reserved for imported members", esc(d["reserved"] ?? 0)],
            ["Cost per new member", `${esc(cost)} credits`],
            ["Alert level", `${esc(d["threshold"] ?? 100)} credits`],
          ]) +
          p("Record the top-up in /admin → ID checks once it is bought."),
        cta: { label: "Open ID checks", url: adminUrl(c) },
      }),
    };
  },
  // Daily (or on-demand) sales summary for managers and admins: totals only, no customer data.
  staff_daily_sales: (d, c) => {
    const pos = (d["pos"] ?? {}) as Record<string, unknown>;
    const online = (d["online"] ?? {}) as Record<string, unknown>;
    const tenders = (d["pos_tenders"] ?? {}) as Record<string, unknown>;
    const methods = (d["online_methods"] ?? {}) as Record<string, unknown>;
    const products = (
      (d["products"] as { name?: unknown; qty?: unknown; revenue?: unknown }[]) ?? []
    ).slice(0, 5);
    const label = (k: string) =>
      ({ cash: "Cash", card: "Card", eft: "EFT", paypal: "PayPal" })[k] ?? k;
    const day = new Date(`${String(d["day"] ?? "")}T12:00:00Z`).toLocaleDateString("en-ZA", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    return {
      subject: `Sales report ${String(d["day"] ?? "")}: ${rand(d["total"])}`,
      html: layout({
        preheader: `${rand(d["total"])} from ${esc(d["transactions"] ?? 0)} sales.`,
        title: "Daily sales report",
        bodyHtml:
          p(`<b>${esc(day)}</b>`) +
          kv([
            ["Total sales", `<b>${rand(d["total"])}</b>`],
            ["Transactions", esc(d["transactions"] ?? 0)],
            ["Average sale", rand(d["average_sale"])],
          ]) +
          p("<b>In store (till)</b>") +
          kv([
            ["Sales", `${esc(pos["count"] ?? 0)} · ${rand(pos["gross"])}`],
            ["Refunds", `${esc(pos["refund_count"] ?? 0)} · ${rand(pos["refunds"])}`],
            ["Voided", `${esc(pos["voided_count"] ?? 0)} · ${rand(pos["voided_total"])}`],
            ["Net", `<b>${rand(pos["net"])}</b>`],
            ...Object.entries(tenders).map(([k, v]): [string, string] => [label(k), rand(v)]),
          ]) +
          p("<b>Online</b>") +
          kv([
            ["Paid orders", `${esc(online["count"] ?? 0)} · ${rand(online["total"])}`],
            [
              "Awaiting payment",
              `${esc(online["awaiting_count"] ?? 0)} · ${rand(online["awaiting_total"])}`,
            ],
            ["Cancelled", esc(online["cancelled_count"] ?? 0)],
            ...Object.entries(methods).map(([k, v]): [string, string] => [label(k), rand(v)]),
          ]) +
          (products.length
            ? p("<b>Top products</b>") +
              kv(
                products.map((x): [string, string] => [
                  String(x.name ?? ""),
                  `${esc(x.qty)} · ${rand(x.revenue)}`,
                ]),
              )
            : ""),
        cta: { label: "Open reports", url: `${adminUrl(c)}#reports` },
      }),
    };
  },
  staff_low_stock: (d, c) => ({
    subject: "Low stock today",
    html: layout({
      preheader: "These products are almost out.",
      title: "Low stock",
      bodyHtml:
        p("These active products have 5 or fewer units available:") +
        kv(
          ((d["items"] as { name?: unknown; available?: unknown }[] | undefined) ?? [])
            .slice(0, 40)
            .map((i): [string, string] => [String(i.name ?? ""), esc(i.available)]),
        ),
      cta: { label: "Open inventory", url: adminUrl(c) },
    }),
  }),
  journal_digest: (d, c) => {
    const base = c.siteUrl.replace(/\/+$/, "");
    const articles = (
      (d["articles"] as { title?: unknown; excerpt?: unknown; slug?: unknown }[] | undefined) ?? []
    ).slice(0, 3);
    const unsub = `${base}/unsubscribe?token=${esc(d["unsubscribe_token"])}`;
    return {
      subject: "This week in the Cannaplug Journal",
      headers: {
        "List-Unsubscribe": `<${unsub}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      html: layout({
        preheader: "New stories from the Journal.",
        title: "This week in the Journal",
        bodyHtml:
          articles
            .map(
              (a) =>
                `<p style="margin:0 0 4px;font-size:16px;font-weight:700"><a href="${base}/journal/${esc(a.slug)}" style="color:${BRAND.green};text-decoration:none">${esc(a.title)}</a></p><p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:${BRAND.muted}">${esc(a.excerpt)}</p>`,
            )
            .join("") +
          p(
            `Not for you? <a href="${unsub}" style="color:${BRAND.green}">Unsubscribe in one click</a>.`,
          ),
        cta: { label: "Read the Journal", url: `${base}/journal` },
        footerNote:
          "You are receiving this because you subscribed on the Cannaplug website. For adults 18 and over.",
      }),
    };
  },
  promo_announcement: (d, c) => {
    const base = c.siteUrl.replace(/\/+$/, "");
    const test = d["test"] === true;
    const unsub = `${base}/unsubscribe?token=${esc(d["unsubscribe_token"])}`;
    const paragraphs = String(d["body"] ?? "")
      .split(/\n\s*\n/)
      .map((para) => para.trim())
      .filter(Boolean)
      .map((para) => p(esc(para).replace(/\n/g, "<br>")))
      .join("");
    const ctaUrl = String(d["cta_url"] ?? "");
    return {
      subject: `${test ? "[TEST] " : ""}${String(d["subject"] ?? d["headline"] ?? "News from Cannaplug").slice(0, 120)}`,
      ...(test
        ? {}
        : {
            headers: {
              "List-Unsubscribe": `<${unsub}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          }),
      html: layout({
        preheader: String(d["preheader"] ?? "").slice(0, 150),
        title: String(d["headline"] ?? "News from Cannaplug"),
        bodyHtml:
          (test
            ? `<p style="margin:0 0 16px;padding:10px 12px;border-radius:8px;background:#fff8e1;border:1px solid ${BRAND.gold};font-size:13px"><b>Test email.</b> Only you received this. Subscribers get it when the campaign is sent.</p>`
            : "") +
          paragraphs +
          (test
            ? ""
            : p(
                `<span style="font-size:12px;color:${BRAND.muted}">Not for you? <a href="${unsub}" style="color:${BRAND.green}">Unsubscribe in one click</a>.</span>`,
              )),
        ...(d["cta_label"] && /^https:\/\//.test(ctaUrl)
          ? { cta: { label: String(d["cta_label"]), url: ctaUrl } }
          : {}),
        footerNote:
          "You are receiving this because you subscribed to CannaPlug news and offers. For adults 18 and over.",
      }),
    };
  },
  staff_eft_approval: (d, c) => ({
    subject: "EFT awaiting your approval",
    html: layout({
      preheader: "A large EFT needs a second manager.",
      title: "EFT awaiting approval",
      bodyHtml:
        p(
          "A large EFT payment was recorded and needs a second manager to approve it before the order is confirmed.",
        ) + kv([["Amount", esc(rand(d["amount"]))]]),
      cta: { label: "Open payments", url: adminUrl(c) },
    }),
  }),
  staff_refund_needed: (d, c) => ({
    subject: "Refund needed — payment received for an unfulfillable order",
    html: layout({
      preheader: "Money arrived that cannot be applied to an order.",
      title: "Refund needed",
      bodyHtml:
        p(
          esc(
            d["reason"] ??
              "A payment was received that cannot be applied to its order. Please refund the customer.",
          ),
        ) + (d["order_id"] ? kv([["Order", esc(d["order_number"] ?? d["order_id"])]]) : ""),
      cta: { label: "Open payments", url: adminUrl(c) },
    }),
  }),
  // ---- Clinical pipeline: deliberately content-free. No document type, practitioner, member name, medicine or
  // reason ever appears; the link leads to the signed-in area, where access is checked and audited.
  practitioner_request_assigned: (_d, c) => ({
    subject: "A request is waiting for you",
    html: layout({
      preheader: "Sign in to see it.",
      title: "New request",
      bodyHtml: p(
        "A request has been assigned to you. Sign in to your practitioner portal to see it.",
      ),
      cta: { label: "Open my portal", url: doctorUrl(c) },
      footerNote: CLINICAL_NOTE,
    }),
  }),
  practitioner_document_waiting: (_d, c) => ({
    subject: "You have a document waiting",
    html: layout({
      preheader: "Sign in to continue.",
      title: "Document waiting",
      bodyHtml: p(
        "A document is waiting for your review or signature. Sign in to your practitioner portal to continue.",
      ),
      cta: { label: "Open my portal", url: doctorUrl(c) },
      footerNote: CLINICAL_NOTE,
    }),
  }),
  clinical_request_completed: (_d, c) => ({
    subject: "There's an update on your request",
    html: layout({
      preheader: "Sign in to see it.",
      title: "Request update",
      bodyHtml: p(
        "There is an update on your request. Sign in to your CannaPlug account to see it.",
      ),
      cta: { label: "My documents", url: documentsUrl(c) },
      footerNote: CLINICAL_NOTE,
    }),
  }),
  clinical_request_declined: (_d, c) => ({
    subject: "There's an update on your request",
    html: layout({
      preheader: "Sign in to see it.",
      title: "Request update",
      bodyHtml: p(
        "There is an update on your request. Sign in to your CannaPlug account to see it, or contact the team if you have questions.",
      ),
      cta: { label: "My documents", url: documentsUrl(c) },
      footerNote: CLINICAL_NOTE,
    }),
  }),
  document_ready: (_d, c) => ({
    subject: "You have a document waiting",
    html: layout({
      preheader: "Sign in to view it.",
      title: "Document ready",
      bodyHtml: p("A document is ready in your CannaPlug account. Sign in to view it."),
      cta: { label: "My documents", url: documentsUrl(c) },
      footerNote: CLINICAL_NOTE,
    }),
  }),
  document_revoked: (_d, c) => ({
    subject: "There's an update on one of your documents",
    html: layout({
      preheader: "Sign in to see it.",
      title: "Document update",
      bodyHtml: p(
        "One of your documents has been updated. Sign in to your CannaPlug account to see its status.",
      ),
      cta: { label: "My documents", url: documentsUrl(c) },
      footerNote: CLINICAL_NOTE,
    }),
  }),
  staff_prescription_revoked: (d, c) => ({
    subject: `Check order ${String(d["order_number"] ?? "")} before packing`.trim(),
    html: layout({
      preheader: "A linked document is no longer valid.",
      title: "Order needs a check",
      bodyHtml:
        p(
          "A document linked to this order is no longer valid. Please check the order with the member before packing.",
        ) + kv([["Order", esc(d["order_number"] ?? "")]]),
      cta: { label: "Open orders", url: adminUrl(c) },
    }),
  }),
};

export function renderTemplate(template: string, data: TemplateData, ctx: Ctx): Rendered | null {
  const t = TEMPLATES[template];
  if (!t) return null;
  const r = t(data ?? {}, ctx);
  const out: Rendered = { subject: r.subject, html: r.html, text: r.text ?? strip(r.html) };
  if (r.replyTo) out.replyTo = r.replyTo;
  if (r.headers) out.headers = r.headers;
  if (r.sms) out.sms = r.sms;
  return out;
}
