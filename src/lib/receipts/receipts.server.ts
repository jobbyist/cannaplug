import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { sendWithResend, senderFromEnv } from "@/lib/email/sender";
import {
  buildReceiptModel,
  formatRand,
  receiptText,
  type PaperSize,
  type ReceiptModel,
  type ReceiptSettings,
} from "./receipt-model";
import { renderReceiptPdf } from "./receipt-pdf";

export const MAX_EMAILS_PER_SALE = 5;

const SETTINGS_COLUMNS =
  "trading_name,legal_name,registration_number,licence_lines,address,phone,email,vat_registered,vat_number,vat_rate,footer_message,returns_policy,default_paper";

async function loadSettings(): Promise<ReceiptSettings> {
  const { data, error } = await supabaseAdmin
    .from("receipt_settings")
    .select(SETTINGS_COLUMNS)
    .eq("id", true)
    .single();
  if (error || !data) throw new Error("Receipt settings are missing.");
  return { ...data, vat_rate: Number(data.vat_rate) } as ReceiptSettings;
}

/** Budtender+: the business details printed on receipts. */
export async function getReceiptSettings(userId: string) {
  await assertRole(userId, "budtender");
  return loadSettings();
}

/** Manager+: edit the receipt details (VAT switch included). */
export async function saveReceiptSettings(userId: string, input: ReceiptSettings) {
  await assertRole(userId, "manager");
  if (input.vat_registered && !input.vat_number)
    throw new Error("Enter the VAT number before switching VAT on.");
  const { error } = await supabaseAdmin
    .from("receipt_settings")
    .update({ ...input, updated_at: new Date().toISOString(), updated_by: userId })
    .eq("id", true);
  if (error) {
    if (error.code === "23514")
      throw new Error("Check the VAT number (10 digits starting with 4).");
    throw error;
  }
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: "receipt_settings_updated",
    entity_type: "receipt_settings",
    entity_id: null,
    metadata: { vat_registered: input.vat_registered, default_paper: input.default_paper },
  });
  return loadSettings();
}

async function buildModel(saleId: string): Promise<ReceiptModel> {
  const { data: sale, error } = await supabaseAdmin
    .from("pos_sales")
    .select(
      "id,receipt_number,created_at,status,subtotal,discount_rand,total,cashier_id,customer_id,staff_purchase",
    )
    .eq("id", saleId)
    .maybeSingle();
  if (error) throw error;
  if (!sale) throw new Error("Sale not found.");
  const [items, tenders, meta, settings, people] = await Promise.all([
    supabaseAdmin
      .from("pos_sale_items")
      .select(
        "product_id,product_name,quantity,unit_price_rand,line_discount_rand,order_discount_rand,line_total",
      )
      .eq("sale_id", saleId),
    supabaseAdmin.from("pos_tenders").select("method,amount,reference").eq("sale_id", saleId),
    supabaseAdmin
      .from("pos_receipt_meta")
      .select("cash_received")
      .eq("sale_id", saleId)
      .maybeSingle(),
    loadSettings(),
    supabaseAdmin
      .from("profiles")
      .select("id,full_name")
      .in("id", [sale.cashier_id, sale.customer_id].filter(Boolean) as string[]),
  ]);
  if (items.error) throw items.error;
  if (tenders.error) throw tenders.error;
  const productIds = (items.data ?? []).map((i) => i.product_id);
  const units = productIds.length
    ? ((await supabaseAdmin.from("products").select("id,unit,sold_by_weight").in("id", productIds))
        .data ?? [])
    : [];
  const unitOf = new Map(units.map((u) => [u.id, u.sold_by_weight ? "g" : null]));
  const nameOf = new Map((people.data ?? []).map((p) => [p.id, p.full_name]));
  return buildReceiptModel({
    sale: {
      receipt_number: sale.receipt_number,
      created_at: sale.created_at,
      status: sale.status,
      subtotal: Number(sale.subtotal),
      discount_rand: Number(sale.discount_rand),
      staff_purchase: sale.staff_purchase,
      total: Number(sale.total),
    },
    items: (items.data ?? []).map((i) => ({
      product_name: i.product_name,
      quantity: i.quantity,
      unit_price_rand: Number(i.unit_price_rand),
      line_total: Number(i.line_total),
      line_discount_rand: Number(i.line_discount_rand),
      order_discount_rand: Number(i.order_discount_rand),
      unit: unitOf.get(i.product_id) ?? null,
    })),
    tenders: (tenders.data ?? []).map((t) => ({
      method: t.method,
      amount: Number(t.amount),
      reference: t.reference,
    })),
    settings,
    cashierName: nameOf.get(sale.cashier_id) ?? null,
    customerName: sale.customer_id ? (nameOf.get(sale.customer_id) ?? null) : null,
    cashReceived: meta.data?.cash_received != null ? Number(meta.data.cash_received) : null,
    loyaltyPoints: null,
  });
}

/** Budtender+: the receipt for one till sale. */
export async function getPosReceipt(userId: string, saleId: string) {
  await assertRole(userId, "budtender");
  return buildModel(saleId);
}

/** Budtender+: remembers how much cash the customer handed over, so the receipt can show change. Once per sale. */
export async function recordCashReceived(userId: string, saleId: string, cashReceived: number) {
  await assertRole(userId, "budtender");
  const { error } = await supabaseAdmin
    .from("pos_receipt_meta")
    .upsert(
      { sale_id: saleId, cash_received: cashReceived, created_by: userId },
      { onConflict: "sale_id", ignoreDuplicates: true },
    );
  if (error) throw error;
  return { ok: true };
}

/** Budtender+: the branded PDF as base64 (for download or printing). */
export async function posReceiptPdf(userId: string, saleId: string, paper: PaperSize) {
  await assertRole(userId, "budtender");
  const model = await buildModel(saleId);
  const bytes = await renderReceiptPdf(model, paper);
  return {
    filename: `CannaPlug-${model.receiptNumber}.pdf`,
    base64: Buffer.from(bytes).toString("base64"),
  };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Budtender+: emails the receipt (PDF attached) through Resend. Transactional: no marketing content. */
export async function emailPosReceipt(
  userId: string,
  saleId: string,
  email: string,
  paper: PaperSize,
  fetchFn: typeof fetch = fetch,
) {
  await assertRole(userId, "budtender");
  const to = email.trim().toLowerCase();
  if (!EMAIL_RE.test(to) || to.length > 254) throw new Error("Enter a valid email address.");
  const apiKey = process.env["RESEND_API_KEY"]?.trim();
  if (!apiKey)
    throw new Error("Email is not set up yet (RESEND_API_KEY). Print the receipt instead.");
  // Resend allows 100 emails a day: when today's budget is used up, the till prints instead.
  const { data: budget } = await supabaseAdmin.rpc("email_budget_status");
  if (budget && (budget as { receipts_open?: boolean }).receipts_open === false)
    throw new Error("Today's email limit has been reached. Print the receipt instead.");
  const { count } = await supabaseAdmin
    .from("pos_receipt_sends")
    .select("id", { count: "exact", head: true })
    .eq("sale_id", saleId);
  if ((count ?? 0) >= MAX_EMAILS_PER_SALE)
    throw new Error(`This receipt has already been emailed ${MAX_EMAILS_PER_SALE} times.`);
  const model = await buildModel(saleId);
  const pdf = await renderReceiptPdf(model, paper);
  const b = model.business;
  const html = `<div style="font-family:Inter,Arial,sans-serif;color:#111;max-width:520px;margin:auto">
<h2 style="font-family:Montserrat,Arial,sans-serif;color:#0B3D20;margin:0 0 4px">Your ${escapeHtml(b.trading_name)} receipt</h2>
<p style="margin:0 0 16px;color:#6B7280">${escapeHtml(model.receiptNumber)} · ${escapeHtml(model.issuedAtLocal)}</p>
<p style="font-size:18px;margin:0 0 16px"><b>Total ${escapeHtml(formatRand(model.total))}</b></p>
<p>Your receipt is attached as a PDF. Thank you for shopping with us.</p>
<p style="color:#6B7280;font-size:12px">${escapeHtml(b.legal_name)} · ${escapeHtml(b.address)}${b.phone ? ` · ${escapeHtml(b.phone)}` : ""}</p>
</div>`;
  const sender = senderFromEnv(process.env);
  const res = await sendWithResend(
    fetchFn,
    apiKey,
    b.email ? { ...sender, replyTo: b.email } : sender,
    {
      to: [to],
      subject: `Your ${b.trading_name} receipt ${model.receiptNumber}`,
      html,
      text: receiptText(model),
      attachments: [
        {
          filename: `CannaPlug-${model.receiptNumber}.pdf`,
          content: Buffer.from(pdf).toString("base64"),
        },
      ],
    },
    `pos-receipt-${saleId}-${to}-${count ?? 0}`,
  );
  const body = res.body;
  if (res.status < 200 || res.status >= 300)
    throw new Error("The email could not be sent. Please try again or print the receipt.");
  let messageId: string | null = null;
  try {
    messageId = (JSON.parse(body) as { id?: string }).id ?? null;
  } catch {
    messageId = null;
  }
  await supabaseAdmin
    .from("pos_receipt_sends")
    .insert({ sale_id: saleId, email: to, provider_message_id: messageId, actor_user_id: userId });
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: "pos_receipt_emailed",
    entity_type: "pos_sale",
    entity_id: saleId,
    metadata: { receipt_number: model.receiptNumber },
  });
  return { sent: true };
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
