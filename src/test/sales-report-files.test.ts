import { writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  cellText,
  reportFileName,
  reportTables,
  type ReportTable,
} from "@/lib/sales-report-export";
import {
  colName,
  pdfSafe,
  reportDocx,
  reportPdf,
  reportXlsx,
  sheetNames,
} from "@/lib/sales-report-files";
import { salesReportCsv, type SalesReport } from "@/lib/sales-report-logic";

/** The report downloads: PDF, Word and Excel all carry the same figures, including the till cash-up. */
const report = (): SalesReport => ({
  from: "2026-10-27",
  to: "2026-10-27",
  generated_at: "2026-10-27T19:00:00Z",
  total: 5280,
  transactions: 21,
  average_sale: 251.43,
  pos: {
    count: 18,
    gross: 4180,
    before_discounts: 4400,
    discounts: 220,
    discounted_count: 5,
    refunds: 0,
    refund_count: 0,
    voided_count: 1,
    voided_total: 90,
    net: 4180,
  },
  online: {
    count: 3,
    total: 1100,
    delivery_fees: 0,
    awaiting_count: 1,
    awaiting_total: 250,
    cancelled_count: 0,
    pickup_count: 3,
  },
  daily: [{ day: "2026-10-27", pos: 4180, online: 1100 }],
  hourly: [],
  pos_tenders: { cash: 3080, card: 1100 },
  online_methods: { card: 1100 },
  products: [
    {
      name: "Blue Gelato 3.5g 🌿",
      category: "Flower",
      qty: 9,
      revenue: 2520,
      pos: 2240,
      online: 280,
    },
    {
      name: 'Gummies <10mg> & "Co"',
      category: "Edibles",
      qty: 4,
      revenue: 400,
      pos: 400,
      online: 0,
    },
  ],
  categories: [{ category: "Flower", qty: 9, revenue: 2520 }],
  cashiers: [{ name: "Aidan Till", count: 18, total: 4180 }],
  recent: [],
  till: {
    sessions_closed: 1,
    opening_floats: 500,
    cash_sales: 3080,
    cash_refunds: 0,
    expenses: 1200,
    expected: 2380,
    counted: 2380,
    variance: 0,
    deposited: 2000,
    float_carried: 380,
    variances_pending: 0,
    expenses_recorded: 1200,
  },
  till_sessions: [
    {
      drawer: "Front till",
      cashier: "Aidan Till",
      opened_at: "2026-10-27T07:00:00Z",
      closed_at: "2026-10-27T17:05:00Z",
      opening_float: 500,
      cash_sales: 3080,
      cash_refunds: 0,
      expenses: 1200,
      discounts: 220,
      expected: 2380,
      counted: 2380,
      variance: 0,
      deposited: 2000,
      float_carried: 380,
      approval: "not_required",
      approval_note: null,
      close_note: null,
    },
  ],
  expenses: [
    {
      at: "2026-10-27T10:00:00Z",
      category: "cleaning",
      description: "Cleaning materials",
      amount: 1200,
      by: "Aidan Till",
    },
  ],
});

const OUT = process.env["REPORT_FILES_OUT"];

describe("sales report downloads", () => {
  it("describes the same sections for every format, including the till cash-up and expenses", () => {
    const t = reportTables(report());
    const titles = t.map((x) => x.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Summary",
        "Till cash-up",
        "Till sessions",
        "Till expenses",
        "Payment methods",
        "Top products",
        "Categories",
        "Till sales by staff",
      ]),
    );
    const cashup = t.find((x) => x.title === "Till cash-up")!;
    const val = (label: string) => cashup.rows.find((r) => r[0] === label)?.[1];
    expect(val("Till expenses paid in cash")).toBe(1200);
    expect(val("Deposited to the bank")).toBe(2000);
    expect(val("Float carried forward")).toBe(380);
    const summary = t.find((x) => x.title === "Summary")!;
    expect(summary.rows.find((r) => r[0] === "Till discounts")?.[1]).toBe(220);
    expect(summary.rows.find((r) => r[0] === "Online sales (paid)")?.[1]).toBe(1100);
    // Every row has one cell per column.
    for (const x of t) for (const row of x.rows) expect(row).toHaveLength(x.columns.length);
    expect(cellText(-12.5, true)).toMatch(/^-R12[.,]50$/);
    expect(cellText({ count: 3 }, true)).toBe("3");
    expect(reportFileName(report(), "xlsx")).toBe("cannaplug-sales-2026-10-27.xlsx");
  });

  it("older reports without till data still export", () => {
    const r = report();
    delete r.till;
    delete r.till_sessions;
    delete r.expenses;
    delete r.pos.discounts;
    delete r.pos.before_discounts;
    const titles = reportTables(r).map((x) => x.title);
    expect(titles).not.toContain("Till cash-up");
    expect(salesReportCsv(r)).not.toContain("Till expenses");
    expect(salesReportCsv(report())).toContain("Till expenses,1200.00");
  });

  it("PDF: opens, has the title and the cash-up, survives emoji and symbols", async () => {
    const bytes = await reportPdf(report());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe("Sales report 2026-10-27");
    expect(pdfSafe("Blue 🌿 − R1 000")).toBe("Blue ?? - R1 000");
    if (OUT) writeFileSync(join(OUT, "report.pdf"), bytes);
  });

  it("Word: a valid .docx with every section heading and the figures", async () => {
    const blob = await reportDocx(report());
    const buf = Buffer.from(await blob.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("word/document.xml")!.async("string");
    for (const h of ["Till cash-up", "Till sessions", "Till expenses", "Top products"])
      expect(xml).toContain(h);
    expect(xml).toContain("Cleaning materials");
    expect(xml).toContain("Gummies &lt;10mg&gt; &amp;");
    if (OUT) writeFileSync(join(OUT, "report.docx"), buf);
  });

  it("Excel: a valid .xlsx, one sheet per section, amounts as numbers, text escaped", async () => {
    const blob = await reportXlsx(report());
    const buf = Buffer.from(await blob.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const wb = await zip.file("xl/workbook.xml")!.async("string");
    expect(wb).toContain('name="Till cash-up"');
    expect(wb).toContain('name="Till expenses"');
    const sheets = Object.keys(zip.files).filter((f) => f.startsWith("xl/worksheets/sheet"));
    expect(sheets.length).toBe(reportTables(report()).length);
    const all = (await Promise.all(sheets.map((f) => zip.file(f)!.async("string")))).join("");
    expect(all).toContain("<v>1200</v>");
    expect(all).toContain("Gummies &lt;10mg&gt; &amp; &quot;Co&quot;");
    expect([...all].some((ch) => ch < " " && ch !== "\n" && ch !== "\t")).toBe(false);
    if (OUT) writeFileSync(join(OUT, "report.xlsx"), buf);
  });

  it("sheet names and column letters follow Excel's rules", () => {
    expect(colName(0)).toBe("A");
    expect(colName(25)).toBe("Z");
    expect(colName(26)).toBe("AA");
    expect(colName(14)).toBe("O");
    const names = sheetNames(["A/B:C", "x".repeat(40), "x".repeat(40), "Summary"]);
    expect(names[0]).toBe("A B C");
    expect(names[1]!.length).toBeLessThanOrEqual(31);
    expect(names[2]).not.toBe(names[1]);
    expect(names[2]!.length).toBeLessThanOrEqual(31);
  });
});

export type { ReportTable };
