/**
 * Notification templates. Pure functions of (template id, queued data): no I/O, so they are trivially
 * testable and are never rendered on a UI path — only the dispatcher calls them, after claiming a queued row.
 * Every interpolated value is HTML-escaped. Visual language follows the site: deep green header,
 * Montserrat headings, off-white card, gold accent for compliance notes.
 */
export interface Rendered {
  subject: string;
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
  green: "#17432b",
  accent: "#2db35e",
  bg: "#f6faf6",
  ink: "#14201a",
  muted: "#5d6b63",
  gold: "#c9a64a",
  supportEmail: "info@cannaplug012.co.za",
} as const;

function layout(opts: {
  preheader: string;
  title: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
  footerNote?: string;
}): string {
  const { preheader, title, bodyHtml, cta, footerNote } = opts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:${BRAND.bg};font-family:Inter,Arial,sans-serif;color:${BRAND.ink}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #dfe9e1;border-radius:14px;overflow:hidden">
<tr><td style="background:${BRAND.green};padding:20px 28px"><span style="font-family:Montserrat,Arial,sans-serif;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#ffffff;font-size:16px">${BRAND.name}</span></td></tr>
<tr><td style="padding:28px">
<h1 style="font-family:Montserrat,Arial,sans-serif;font-size:20px;line-height:1.25;margin:0 0 14px;text-transform:uppercase;letter-spacing:.02em;color:${BRAND.green}">${esc(title)}</h1>
${bodyHtml}
${cta ? `<p style="margin:24px 0 4px"><a href="${esc(cta.url)}" style="background:${BRAND.accent};color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px;display:inline-block;font-size:14px">${esc(cta.label)}</a></p>` : ""}
</td></tr>
<tr><td style="padding:18px 28px;background:#f1f6f2;color:${BRAND.muted};font-size:12px;line-height:1.5">
${footerNote ? `<p style="margin:0 0 8px;border-left:3px solid ${BRAND.gold};padding-left:10px">${esc(footerNote)}</p>` : ""}
<p style="margin:0">Cannaplug · Questions? Reply to this email or write to <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.green}">${BRAND.supportEmail}</a>.</p>
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

const orderRows = (d: TemplateData): [string, string][] => [
  ["Order", esc(d["order_number"])],
  ["Total", esc(rand(d["total_rand"]))],
];
const accountUrl = (c: Ctx) => `${c.siteUrl.replace(/\/+$/, "")}/account`;
const adminUrl = (c: Ctx) => `${c.siteUrl.replace(/\/+$/, "")}/admin`;
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
        p("We have verified your payment and are now preparing your order.") +
        kv(orderRows(d)),
      cta: { label: "Track my order", url: accountUrl(c) },
    }),
  }),
  order_ready: (d, c) => ({
    subject: `Your order ${d["order_number"]} is ready`,
    sms: `Cannaplug: order ${d["order_number"]} is ready.`,
    html: layout({
      preheader: "Your order is packed and ready.",
      title: "Your order is ready",
      bodyHtml:
        p(hi(d)) +
        p(
          d["delivery_method"] === "collection"
            ? "Your order is ready for collection. Bring a valid ID."
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
};

export function renderTemplate(template: string, data: TemplateData, ctx: Ctx): Rendered | null {
  const t = TEMPLATES[template];
  if (!t) return null;
  const r = t(data ?? {}, ctx);
  const out: Rendered = { subject: r.subject, html: r.html, text: r.text ?? strip(r.html) };
  if (r.sms) out.sms = r.sms;
  return out;
}
