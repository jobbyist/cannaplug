import { TEMPLATES, renderTemplate } from "../src/lib/notifications/templates";

/** Sample data for every template, shared by the preview renderer and the test-send script. */
export const SITE = "https://cannaplug012.co.za";
const order = {
  order_id: "o1",
  order_number: "CP-100245",
  total_rand: 1185,
  contact_name: "Thandi Mokoena",
  delivery_method: "discreet",
  payment_method: "eft",
  status: "confirmed",
};
export const SAMPLES: Record<string, Record<string, unknown>> = {
  order_received: order,
  order_confirmed: order,
  order_ready: { ...order, delivery_method: "collection" },
  order_out_for_delivery: order,
  order_completed: order,
  order_cancelled: order,
  member_welcome: { contact_name: "Thandi Mokoena" },
  id_submitted: { contact_name: "Thandi Mokoena" },
  id_approved: { contact_name: "Thandi Mokoena", document_expires_on: "2031-04-12" },
  id_rejected: { contact_name: "Thandi Mokoena", rejection_code: "unreadable" },
  id_expiring: { contact_name: "Thandi Mokoena", document_expires_on: "2026-10-28" },
  back_in_stock: { product_name: "Gorilla Zkittlez" },
  contact_form_ack: { name: "Thandi Mokoena", subject: "Do you stock CBD tinctures?" },
  contact_form_staff: {
    name: "Thandi Mokoena",
    email: "thandi@example.com",
    subject: "Do you stock CBD tinctures?",
    message: "Hi team,\nDo you stock CBD tinctures, and can I collect on Saturday?",
  },
  newsletter_welcome: { unsubscribe_token: "0".repeat(48) },
  journal_digest: {
    unsubscribe_token: "0".repeat(48),
    articles: [
      {
        title: "Dagga's long road from the Cape to the courts",
        excerpt: "How South Africa's cannabis story moved from the margins to the constitution.",
        slug: "daggas-long-road",
      },
      {
        title: "Hemp farming in the Eastern Cape",
        excerpt: "Smallholders are betting on a crop with a very old name.",
        slug: "hemp-eastern-cape",
      },
      {
        title: "Inside a Pretoria cannabis club night",
        excerpt: "Music, community and a lot of etiquette.",
        slug: "pretoria-club-night",
      },
    ],
  },
  promo_announcement: {
    headline: "Plug Back weekend",
    preheader: "Bring your tubes, get a pre-roll.",
    body: "This weekend only, double rewards points on every in-store purchase.\nBring 10 empty Cannaplug tubes for a complimentary Greenhouse pre-roll while stocks last.",
    cta_label: "See what's new",
    cta_url: SITE + "/shop",
    unsubscribe_token: "0".repeat(48),
  },
  staff_new_order: order,
  staff_payment_review: {
    reason: "Payment mismatch: amount_mismatch",
    transaction_id: "7f1c2a9e-0000-4000-8000-000000000000",
  },
  staff_refund_needed: {
    reason: "paid_after_cancel_needs_refund",
    order_id: "o1",
    order_number: "CP-100245",
  },
  staff_eft_approval: { amount: 12500 },
  staff_id_review: { member_name: "Thandi Mokoena" },
  staff_low_stock: {
    items: [
      { name: "Gorilla Zkittlez", available: 2 },
      { name: "Blue Gelato", available: 4 },
    ],
  },
};

export function renderAll() {
  const missing = Object.keys(TEMPLATES).filter((t) => !(t in SAMPLES));
  if (missing.length) throw new Error(`no sample data for: ${missing.join(", ")}`);
  return Object.entries(SAMPLES).map(([name, data]) => ({
    name,
    rendered: renderTemplate(name, data, { siteUrl: SITE })!,
  }));
}
