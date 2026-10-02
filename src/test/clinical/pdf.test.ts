import { describe, expect, it } from "vitest";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import {
  FOOTER_TEXT,
  renderDocumentPdf,
  validatePdf,
  type PdfInput,
} from "@/lib/clinical/pdf.server";
import { sha256Hex } from "@/lib/clinical/hash";

const base: PdfInput = {
  documentId: "CP-MED-2026-000184",
  documentType: "MEDICAL_LETTER",
  content:
    "Line one of the approved document.\n\nPatient: Test Member\nA second paragraph that is quite long ".repeat(
      3,
    ),
  issueDate: "2026-10-02",
  expiresAt: "2027-01-31T21:59:59Z",
  verificationUrl: "https://cannaplug.example/verify/" + "A".repeat(43),
  createdAt: new Date("2026-10-02T08:00:00Z"),
  signature: null,
};
const signed: PdfInput = {
  ...base,
  signature: {
    practitioner: "Dr Jane Smith",
    registrationNumber: "MP0123456",
    assurance: "SIMPLE",
    method: "SIMPLE_INTERNAL_ATTESTATION",
    signedAt: "2026-10-02T08:05:00Z",
    reference: "ATT-abc123",
  },
};

/** Decodes every content stream and returns the drawn text (WinAnsi hex strings) joined by spaces, plus the operator text. */
async function extract(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let ops = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream)
      ops += new TextDecoder("latin1").decode(decodePDFRawStream(obj).decode()) + "\n";
  }
  const strings = [...ops.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) =>
    m[1]!
      .match(/../g)!
      .map((h) => String.fromCharCode(parseInt(h, 16)))
      .join(""),
  );
  return { text: strings.join(" "), lines: strings, rectangles: (ops.match(/^h$/gm) ?? []).length };
}
const has = async (bytes: Uint8Array, s: string) => (await extract(bytes)).text.includes(s);

describe("PDF rendering", () => {
  it("produces a valid, parseable PDF", async () => {
    const bytes = await renderDocumentPdf(signed);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    const check = await validatePdf(bytes);
    expect(check.ok).toBe(true);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("is deterministic: identical input gives identical bytes (so issuing can be retried)", async () => {
    const [a, b] = await Promise.all([renderDocumentPdf(signed), renderDocumentPdf(signed)]);
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
  });

  it("changes when any content changes (hash covers the document)", async () => {
    const a = await renderDocumentPdf(signed);
    const b = await renderDocumentPdf({ ...signed, content: signed.content + "!" });
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
  });

  it("prints the required chrome: id, footer, verification URL, signature facts", async () => {
    const bytes = await renderDocumentPdf(signed);
    expect(await has(bytes, "CannaPlug")).toBe(true);
    expect(await has(bytes, "CP-MED-2026-000184")).toBe(true);
    expect(await has(bytes, FOOTER_TEXT)).toBe(true);
    expect(await has(bytes, "Medical letter")).toBe(true);
    expect(await has(bytes, "Verify this document")).toBe(true);
    expect(await has(bytes, "HPCSA registration number: MP0123456")).toBe(true);
    expect(await has(bytes, "Dr Jane Smith")).toBe(true);
    expect(await has(bytes, "Signature reference: ATT-abc123")).toBe(true);
  });

  it("states honestly that a simple signature is not advanced or qualified", async () => {
    const bytes = await renderDocumentPdf(signed);
    expect(await has(bytes, "Simple electronic signature")).toBe(true);
    expect(await has(bytes, "not an advanced or qualified electronic signature")).toBe(true);
    const adv = await renderDocumentPdf({
      ...signed,
      signature: { ...signed.signature!, assurance: "ADVANCED", method: "EXTERNAL_PROVIDER" },
    });
    expect(await has(adv, "not an advanced or qualified electronic signature")).toBe(false);
    expect(await has(adv, "Advanced electronic signature")).toBe(true);
  });

  it("says PENDING before signing and never claims a signature", async () => {
    const bytes = await renderDocumentPdf(base);
    expect(await has(bytes, "Signature status: PENDING")).toBe(true);
    expect(await has(bytes, "Electronically approved and signed by")).toBe(false);
  });

  it("draws a QR code as vector graphics", async () => {
    const withQr = await renderDocumentPdf(base);
    const other = await renderDocumentPdf({
      ...base,
      verificationUrl: "https://cannaplug.example/verify/" + "B".repeat(43),
    });
    expect(await sha256Hex(withQr)).not.toBe(await sha256Hex(other));
    expect((await extract(withQr)).rectangles).toBeGreaterThan(100);
  });

  it("does not put names or health content in the file metadata", async () => {
    const doc = await PDFDocument.load(await renderDocumentPdf(signed), { updateMetadata: false });
    expect(doc.getTitle()).toBe("CannaPlug CP-MED-2026-000184");
    expect(doc.getAuthor() ?? "").toBe("");
    expect(`${doc.getSubject()}${doc.getKeywords()}${doc.getCreator()}`).not.toMatch(
      /Test Member|Smith|MP0123/,
    );
    expect(doc.getCreationDate()?.toISOString()).toBe("2026-10-02T08:00:00.000Z");
  });

  it("paginates long documents and keeps the footer on every page", async () => {
    const long = Array.from(
      { length: 160 },
      (_, i) => `Paragraph ${i} with some words to fill the line properly.`,
    ).join("\n");
    const bytes = await renderDocumentPdf({ ...signed, content: long });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(2);
    expect((await extract(bytes)).lines.filter((l) => l === FOOTER_TEXT).length).toBe(
      doc.getPageCount(),
    );
  });

  it("survives characters outside WinAnsi and very long tokens", async () => {
    const bytes = await renderDocumentPdf({
      ...signed,
      content: "Zoë Ñandi 日本語 😀 " + "x".repeat(400),
    });
    expect((await validatePdf(bytes)).ok).toBe(true);
  });
});

describe("PDF validation", () => {
  it("rejects anything that is not a well formed PDF", async () => {
    expect(await validatePdf(new Uint8Array(10))).toEqual({ ok: false, reason: "size" });
    expect(await validatePdf(new TextEncoder().encode("GIF89a".padEnd(300, "x")))).toEqual({
      ok: false,
      reason: "signature",
    });
    expect((await validatePdf(new TextEncoder().encode("%PDF-1.7\n".padEnd(300, "x")))).ok).toBe(
      false,
    );
  });
  it("rejects a PDF with active content", async () => {
    const good = new TextDecoder("latin1").decode(await renderDocumentPdf(signed));
    const evil = new TextEncoder().encode(
      good.replace("%%EOF", "/JavaScript (app.alert(1))\n%%EOF"),
    );
    expect(await validatePdf(evil)).toEqual({ ok: false, reason: "active_content" });
  });
  it("rejects a truncated PDF", async () => {
    const bytes = await renderDocumentPdf(signed);
    expect((await validatePdf(bytes.subarray(0, bytes.length - 400))).ok).toBe(false);
  });
  it("detects a modified PDF by hash", async () => {
    const bytes = await renderDocumentPdf(signed);
    const original = await sha256Hex(bytes);
    const tampered = bytes.slice();
    tampered[Math.floor(tampered.length / 2)]! ^= 0xff;
    expect(await sha256Hex(tampered)).not.toBe(original);
  });
});
