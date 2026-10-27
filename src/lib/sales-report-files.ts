import type { SalesReport } from "./sales-report-logic";
import {
  cellNumber,
  cellText,
  reportTables,
  reportTitle,
  sastTime,
  type Cell,
  type ReportTable,
} from "./sales-report-export";

/**
 * Builds the sales report as PDF, Word (.docx) or Excel (.xlsx) in the browser. The libraries are loaded only when
 * someone downloads, so they never weigh on the admin page. Every file is made from `reportTables`, so the three
 * formats carry the same figures as the screen.
 */

export const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

const FOREST = { r: 0x0b / 255, g: 0x3d / 255, b: 0x20 / 255 };

/** The PDF standard fonts only encode Windows-1252: replace anything else so a product name can't break export. */
export const pdfSafe = (s: string) =>
  s
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0|\u202f/g, " ")
    .replace(/[^\x20-\x7e\xa1-\xff]/g, "?");

export async function reportPdf(r: SalesReport): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle(reportTitle(r));
  doc.setCreator("Cannaplug");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // A4 landscape, so the till-session table fits.
  const W = 841.89;
  const H = 595.28;
  const M = 36;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = H - M;
  };
  const fit = (text: string, size: number, width: number, f = font) => {
    const full = pdfSafe(text);
    if (f.widthOfTextAtSize(full, size) <= width) return full;
    let s = full;
    while (s.length > 1 && f.widthOfTextAtSize(`${s}..`, size) > width) s = s.slice(0, -1);
    return `${s}..`;
  };

  page.drawText(pdfSafe(reportTitle(r)), {
    x: M,
    y,
    size: 16,
    font: bold,
    color: rgb(FOREST.r, FOREST.g, FOREST.b),
  });
  y -= 16;
  page.drawText(pdfSafe(`Cannaplug · generated ${sastTime(r.generated_at)} (South African time)`), {
    x: M,
    y,
    size: 8,
    font,
    color: rgb(0.35, 0.35, 0.35),
  });
  y -= 18;

  const drawTable = (t: ReportTable) => {
    const size = t.columns.length > 8 ? 7 : 8.5;
    const rowH = size + 5;
    const usable = W - 2 * M;
    // Text columns get more room than amount columns.
    const weights = t.columns.map((_, i) => (t.money[i] ? 1 : i === 0 ? 2.2 : 1.4));
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / total) * usable);
    const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((a, b) => a + b, 0));

    if (y < M + rowH * 4) newPage();
    page.drawText(pdfSafe(t.title), {
      x: M,
      y,
      size: 11,
      font: bold,
      color: rgb(FOREST.r, FOREST.g, FOREST.b),
    });
    y -= rowH + 2;
    const header = () => {
      page.drawRectangle({
        x: M,
        y: y - 3,
        width: usable,
        height: rowH,
        color: rgb(0.93, 0.95, 0.93),
      });
      t.columns.forEach((c, i) => {
        const text = fit(c, size, widths[i]! - 4, bold);
        const x = t.money[i]
          ? xs[i]! + widths[i]! - 2 - bold.widthOfTextAtSize(text, size)
          : xs[i]! + 2;
        page.drawText(text, { x, y, size, font: bold });
      });
      y -= rowH;
    };
    header();
    if (t.rows.length === 0) {
      page.drawText("Nothing in this period.", {
        x: M + 2,
        y,
        size,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });
      y -= rowH;
    }
    for (const row of t.rows) {
      if (y < M + rowH) {
        newPage();
        header();
      }
      row.forEach((c, i) => {
        const text = fit(cellText(c, t.money[i]!), size, widths[i]! - 4);
        const x = t.money[i]
          ? xs[i]! + widths[i]! - 2 - font.widthOfTextAtSize(text, size)
          : xs[i]! + 2;
        page.drawText(text, { x, y, size, font });
      });
      y -= rowH;
    }
    if (t.note) {
      if (y < M + rowH) newPage();
      page.drawText(fit(t.note, 7, usable), { x: M, y, size: 7, font, color: rgb(0.4, 0.4, 0.4) });
      y -= rowH;
    }
    y -= 10;
  };
  for (const t of reportTables(r)) drawTable(t);
  return doc.save();
}

export async function reportDocx(r: SalesReport): Promise<Blob> {
  const d = await import("docx");
  const cellPara = (text: string, opts: { bold?: boolean; right?: boolean } = {}) =>
    new d.Paragraph({
      alignment: opts.right ? d.AlignmentType.RIGHT : d.AlignmentType.LEFT,
      children: [new d.TextRun({ text, bold: !!opts.bold, size: 16, font: "Calibri" })],
    });
  const children: (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] = [
    new d.Paragraph({ heading: d.HeadingLevel.TITLE, children: [new d.TextRun(reportTitle(r))] }),
    new d.Paragraph({
      children: [
        new d.TextRun({
          text: `Cannaplug · generated ${sastTime(r.generated_at)} (South African time)`,
          size: 16,
          color: "666666",
        }),
      ],
    }),
  ];
  for (const t of reportTables(r)) {
    children.push(
      new d.Paragraph({ heading: d.HeadingLevel.HEADING_2, children: [new d.TextRun(t.title)] }),
    );
    const rows = [
      new d.TableRow({
        tableHeader: true,
        children: t.columns.map(
          (c, i) =>
            new d.TableCell({
              shading: { type: d.ShadingType.CLEAR, fill: "EEF2EE", color: "auto" },
              children: [cellPara(c, { bold: true, right: t.money[i]! })],
            }),
        ),
      }),
      ...(t.rows.length
        ? t.rows
        : [t.columns.map((_, i) => (i === 0 ? "Nothing in this period." : ""))]
      ).map(
        (row) =>
          new d.TableRow({
            children: row.map(
              (c, i) =>
                new d.TableCell({
                  children: [cellPara(cellText(c, t.money[i]!), { right: t.money[i]! })],
                }),
            ),
          }),
      ),
    ];
    children.push(new d.Table({ width: { size: 100, type: d.WidthType.PERCENTAGE }, rows }));
    if (t.note)
      children.push(
        new d.Paragraph({ children: [new d.TextRun({ text: t.note, size: 14, color: "666666" })] }),
      );
  }
  const docx = new d.Document({
    creator: "Cannaplug",
    title: reportTitle(r),
    sections: [
      {
        properties: { page: { size: { orientation: d.PageOrientation.LANDSCAPE } } },
        children,
      },
    ],
  });
  return d.Packer.toBlob(docx);
}

// ---- Excel: a minimal, valid SpreadsheetML workbook, one sheet per table --------------------------------------

const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .split("")
    // Characters XML 1.0 forbids (control codes other than tab and newlines) would make Excel refuse the file.
    .filter((ch) => ch >= " " || ch === "\t" || ch === "\n" || ch === "\r")
    .join("");

/** A1-style column letters: 0 -> A, 25 -> Z, 26 -> AA. */
export const colName = (i: number): string =>
  i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + colName(i % 26);

/** Excel sheet names: max 31 chars, none of []:*?/\ and unique. */
export function sheetNames(titles: string[]): string[] {
  const used = new Set<string>();
  return titles.map((t) => {
    const base =
      t
        .replace(/[[\]:*?/\\]/g, " ")
        .slice(0, 31)
        .trim() || "Sheet";
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base.slice(0, 28)} ${k}`;
    used.add(name.toLowerCase());
    return name;
  });
}

const STYLE = { text: 0, header: 1, money: 2, title: 3 } as const;

function sheetXml(t: ReportTable, title: string): string {
  const rows: string[] = [];
  const cell = (ref: string, c: Cell, s: number) => {
    const num = cellNumber(c);
    // Counts are plain numbers, never in the rand format.
    const style = typeof c === "object" && s === STYLE.money ? STYLE.text : s;
    return num !== null && Number.isFinite(num)
      ? `<c r="${ref}" s="${style}"><v>${num}</v></c>`
      : `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(String(c))}</t></is></c>`;
  };
  rows.push(`<row r="1">${cell("A1", title, STYLE.title)}</row>`);
  rows.push(
    `<row r="3">${t.columns.map((c, i) => cell(`${colName(i)}3`, c, STYLE.header)).join("")}</row>`,
  );
  t.rows.forEach((row, ri) => {
    const r = ri + 4;
    rows.push(
      `<row r="${r}">${row
        .map((c, i) => cell(`${colName(i)}${r}`, c, t.money[i] ? STYLE.money : STYLE.text))
        .join("")}</row>`,
    );
  });
  if (t.note) {
    const r = t.rows.length + 5;
    rows.push(`<row r="${r}">${cell(`A${r}`, t.note, STYLE.text)}</row>`);
  }
  const cols = t.columns
    .map(
      (_, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${t.money[i] ? 14 : i === 0 ? 34 : 20}" customWidth="1"/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${cols}</cols><sheetData>${rows.join("")}</sheetData></worksheet>`
  );
}

export async function reportXlsx(r: SalesReport): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const tables = reportTables(r);
  const names = sheetNames(tables.map((t) => t.title));
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      tables
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("") +
      `</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      names
        .map((nm, i) => `<sheet name="${xml(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("") +
      `</sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      tables
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("") +
      `<Relationship Id="rId${tables.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R&quot;#,##0.00;-&quot;R&quot;#,##0.00"/></numFmts>` +
      `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>` +
      `<font><b/><sz val="14"/><color rgb="FF0B3D20"/><name val="Calibri"/></font></fonts>` +
      `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FFEEF2EE"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="4">` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
      `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
      `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  tables.forEach((t, i) =>
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(t, `${reportTitle(r)} · ${t.title}`)),
  );
  return zip.generateAsync({ type: "blob", mimeType: MIME.xlsx });
}

/** Builds and saves one format. */
export async function downloadReport(
  r: SalesReport,
  format: "pdf" | "docx" | "xlsx",
  fileName: string,
) {
  const blob =
    format === "pdf"
      ? new Blob([(await reportPdf(r)) as BlobPart], { type: MIME.pdf })
      : format === "docx"
        ? await reportDocx(r)
        : await reportXlsx(r);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
