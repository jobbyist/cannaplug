import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatRand, type PaperSize, type ReceiptModel } from "./receipt-model";
import { RECEIPT_LOGO_PNG_BASE64 } from "./logo";

const MM = 72 / 25.4;
const FOREST = rgb(11 / 255, 61 / 255, 32 / 255);
const LEAF = rgb(22 / 255, 163 / 255, 74 / 255);
const GOLD = rgb(212 / 255, 175 / 255, 55 / 255);
const INK = rgb(0.07, 0.07, 0.07);
const SLATE = rgb(107 / 255, 114 / 255, 128 / 255);

type Geometry = { width: number; margin: number; size: number; small: number; logoW: number };
const GEOMETRY: Record<PaperSize, Geometry> = {
  "80mm": { width: 80 * MM, margin: 4 * MM, size: 8.5, small: 7, logoW: 46 * MM },
  "58mm": { width: 58 * MM, margin: 3 * MM, size: 7.5, small: 6.2, logoW: 36 * MM },
  a4: { width: 210 * MM, margin: 20 * MM, size: 10.5, small: 8.5, logoW: 60 * MM },
};

const decodeBase64 = (b64: string) =>
  typeof Buffer !== "undefined"
    ? new Uint8Array(Buffer.from(b64, "base64"))
    : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** pdf-lib's standard fonts are WinAnsi: replace characters they cannot draw. */
const safe = (s: string) =>
  s
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/×/g, "x")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");

type Op = (page: PDFPage, y: number) => void;

/** Renders a branded receipt. Thermal sizes are one long page; A4 is a single page with the same content. */
export async function renderReceiptPdf(m: ReceiptModel, paper: PaperSize): Promise<Uint8Array> {
  const g = GEOMETRY[paper];
  const doc = await PDFDocument.create();
  doc.setTitle(`${m.business.trading_name} receipt ${m.receiptNumber}`);
  doc.setAuthor(m.business.legal_name);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await doc.embedPng(decodeBase64(RECEIPT_LOGO_PNG_BASE64));
  const inner = g.width - g.margin * 2;
  const lineH = g.size * 1.35;
  const ops: { h: number; draw: Op }[] = [];
  const push = (h: number, draw: Op) => ops.push({ h, draw });

  const centred = (text: string, font: PDFFont, size: number, color = INK) => {
    for (const l of wrap(safe(text), font, size, inner))
      push(size * 1.35, (p, y) =>
        p.drawText(l, {
          x: (g.width - font.widthOfTextAtSize(l, size)) / 2,
          y: y - size,
          size,
          font,
          color,
        }),
      );
  };
  const pair = (left: string, right: string, font = regular, size = g.size, color = INK) => {
    const rw = font.widthOfTextAtSize(safe(right), size);
    const lines = wrap(safe(left), font, size, inner - rw - 6);
    lines.forEach((l, i) =>
      push(size * 1.35, (p, y) => {
        p.drawText(l, { x: g.margin, y: y - size, size, font, color });
        if (i === 0)
          p.drawText(safe(right), { x: g.width - g.margin - rw, y: y - size, size, font, color });
      }),
    );
  };
  const rule = (color = SLATE, thickness = 0.5, gap = 5) =>
    push(gap * 2, (p, y) =>
      p.drawLine({
        start: { x: g.margin, y: y - gap },
        end: { x: g.width - g.margin, y: y - gap },
        thickness,
        color,
      }),
    );
  const space = (h: number) => push(h, () => undefined);

  // Header
  const logoH = (g.logoW * logo.height) / logo.width;
  push(logoH + 6, (p, y) =>
    p.drawImage(logo, { x: (g.width - g.logoW) / 2, y: y - logoH, width: g.logoW, height: logoH }),
  );
  centred(m.business.legal_name, bold, g.size, FOREST);
  if (m.business.registration_number)
    centred(`Reg. No. ${m.business.registration_number}`, regular, g.small, SLATE);
  for (const l of m.business.licence_lines) centred(l.toUpperCase(), bold, g.small, LEAF);
  centred(m.business.address, regular, g.small);
  const contact = [m.business.phone, m.business.email].filter(Boolean).join("  |  ");
  if (contact) centred(contact, regular, g.small);
  if (m.vat) centred(`VAT No. ${m.vat.number}`, regular, g.small);
  push(6, (p, y) =>
    p.drawRectangle({ x: g.margin, y: y - 4, width: inner, height: 2, color: GOLD }),
  );

  // Meta
  centred(
    m.vat ? "TAX INVOICE" : m.kind === "refund" ? "REFUND RECEIPT" : "RECEIPT",
    bold,
    g.size + 1,
    FOREST,
  );
  pair("Receipt", m.receiptNumber, bold);
  pair("Date", m.issuedAtLocal);
  pair("Served by", m.cashier);
  if (m.customer) pair("Customer", m.customer);
  if (m.status === "voided") centred("VOIDED", bold, g.size + 2, rgb(0.7, 0.1, 0.1));
  else if (m.status === "refunded" || m.status === "partially_refunded")
    centred(
      m.status === "refunded" ? "REFUNDED" : "PARTIALLY REFUNDED",
      bold,
      g.size,
      rgb(0.6, 0.4, 0),
    );
  rule();

  // Lines
  for (const l of m.lines) {
    pair(l.name, formatRand(l.total));
    push(g.small * 1.4, (p, y) =>
      p.drawText(
        safe(
          `  ${l.quantity}${l.unit ? ` ${l.unit}` : ""} x ${formatRand(l.unitPrice)}${l.unit ? ` / ${l.unit}` : ""}`,
        ),
        { x: g.margin, y: y - g.small, size: g.small, font: regular, color: SLATE },
      ),
    );
  }
  rule();

  // Totals
  pair("TOTAL", formatRand(m.total), bold, g.size + 2, FOREST);
  if (m.vat)
    pair(`Includes VAT @ ${m.vat.rate}%`, formatRand(m.vat.amount), regular, g.small, SLATE);
  space(3);
  for (const t of m.tenders) pair(t.label, formatRand(t.amount));
  if (m.cashReceived != null) pair("Cash received", formatRand(m.cashReceived));
  if (m.change != null) pair("Change", formatRand(m.change), bold);
  if (m.loyaltyPoints) {
    space(3);
    pair("Loyalty points earned", String(m.loyaltyPoints), regular, g.small, LEAF);
  }
  rule();

  // Footer
  if (m.business.footer_message) centred(m.business.footer_message, bold, g.size, FOREST);
  if (m.business.returns_policy) centred(m.business.returns_policy, regular, g.small, SLATE);
  space(4);
  centred("cannaplug012.co.za", bold, g.small, LEAF);
  space(g.margin);

  const contentH = ops.reduce((s, o) => s + o.h, 0) + g.margin;
  const height = paper === "a4" ? Math.max(297 * MM, contentH) : contentH;
  const page = doc.addPage([g.width, height]);
  let y = height - g.margin;
  for (const o of ops) {
    o.draw(page, y);
    y -= o.h;
  }
  void lineH;
  return doc.save();
}
