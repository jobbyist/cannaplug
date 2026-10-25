import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";

export type CampaignInput = {
  subject: string;
  preheader: string | null;
  headline: string;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
};

/** a***@example.com: enough for staff to recognise a delivery, without listing addresses. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "—";
  return `${user.slice(0, 1)}***@${domain}`;
}

const TEMPLATE_LABEL: Record<string, string> = {
  order_received: "Order received",
  order_confirmed: "Payment confirmed",
  order_ready: "Order ready",
  order_out_for_delivery: "Out for delivery",
  order_completed: "Order completed",
  order_cancelled: "Order cancelled",
  member_welcome: "Welcome",
  newsletter_welcome: "Newsletter welcome",
  id_submitted: "ID received",
  id_approved: "ID approved",
  id_rejected: "ID not approved",
  id_expiring: "ID expiring",
  back_in_stock: "Back in stock",
  promo_announcement: "Campaign",
  journal_digest: "Journal digest",
  contact_form_ack: "Contact reply",
};
export const templateLabel = (t: string) =>
  TEMPLATE_LABEL[t] ??
  (t.startsWith("staff_") ? `Staff: ${t.slice(6).replaceAll("_", " ")}` : t.replaceAll("_", " "));

export async function listCampaigns(userId: string) {
  await assertRole(userId, "manager");
  const [{ data, error }, { count }] = await Promise.all([
    supabaseAdmin
      .from("email_campaigns")
      .select(
        "id,subject,preheader,headline,body,cta_label,cta_url,status,recipient_count,created_at,updated_at,sent_at",
      )
      .order("created_at", { ascending: false })
      .limit(50),
    supabaseAdmin
      .from("newsletter_subscribers")
      .select("id", { count: "exact", head: true })
      .is("unsubscribed_at", null),
  ]);
  if (error) throw error;
  return { campaigns: data ?? [], subscribers: count ?? 0 };
}

export async function saveCampaign(
  userId: string,
  id: string | null,
  input: CampaignInput,
  key: string,
) {
  const { data, error } = await supabaseAdmin.rpc("email_campaign_save", {
    p_actor: userId,
    p_id: id as string,
    p_subject: input.subject,
    p_preheader: input.preheader as string,
    p_headline: input.headline,
    p_body: input.body,
    p_cta_label: input.ctaLabel as string,
    p_cta_url: input.ctaUrl as string,
    p_idempotency_key: key,
  });
  if (error) throw error;
  return data as { id: string; status: string };
}

export async function testCampaign(userId: string, id: string, key: string) {
  const { data, error } = await supabaseAdmin.rpc("email_campaign_test", {
    p_actor: userId,
    p_id: id,
    p_idempotency_key: key,
  });
  if (error) throw error;
  return data as { id: string; sent_to: string };
}

export async function sendCampaign(userId: string, id: string, key: string) {
  const { data, error } = await supabaseAdmin.rpc("email_campaign_send", {
    p_actor: userId,
    p_id: id,
    p_idempotency_key: key,
  });
  if (error) throw error;
  return data as { id: string; status: string; recipients: number };
}

/** The last 60 emails and how they did, plus 7-day totals, for Admin -> Promotions -> Email activity. */
export async function emailActivity(userId: string) {
  await assertRole(userId, "manager");
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const [{ data, error }, week] = await Promise.all([
    supabaseAdmin
      .from("notification_events")
      .select("id,template,category,status,recipient,attempts,created_at,sent_at,last_error")
      .eq("channel", "email")
      .order("created_at", { ascending: false })
      .limit(60),
    supabaseAdmin
      .from("notification_events")
      .select("status")
      .eq("channel", "email")
      .gte("created_at", since)
      .limit(5000),
  ]);
  if (error) throw error;
  const totals = { sent: 0, waiting: 0, failed: 0 };
  for (const r of week.data ?? []) {
    if (r.status === "sent") totals.sent++;
    else if (r.status === "queued" || r.status === "sending") totals.waiting++;
    else if (r.status === "dead" || r.status === "failed") totals.failed++;
  }
  return {
    totals,
    rows: (data ?? []).map((r) => ({
      id: r.id,
      label: templateLabel(r.template),
      category: r.category,
      status: r.status,
      to: maskEmail(r.recipient),
      attempts: r.attempts,
      created_at: r.created_at,
      sent_at: r.sent_at,
      // Provider error codes only; never message content.
      error: r.status === "sent" ? null : (r.last_error ?? "").slice(0, 80) || null,
    })),
  };
}

export async function myNewsletter(userId: string) {
  const { data, error } = await supabaseAdmin.rpc("member_newsletter_status", { p_user: userId });
  if (error) throw error;
  return { subscribed: data === true };
}

export async function setMyNewsletter(userId: string, subscribe: boolean, key: string) {
  const { data, error } = await supabaseAdmin.rpc("member_newsletter_set", {
    p_user: userId,
    p_subscribe: subscribe,
    p_idempotency_key: key,
  });
  if (error) throw error;
  return data as { subscribed: boolean };
}
