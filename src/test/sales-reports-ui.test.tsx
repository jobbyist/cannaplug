// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const handlers: (() => void)[] = [];
vi.mock("@/integrations/supabase/client", () => {
  const channel = {
    on: (_t: string, _f: unknown, cb: () => void) => (handlers.push(cb), channel),
    subscribe: (cb: (s: string) => void) => (cb("SUBSCRIBED"), channel),
  };
  return { supabase: { channel: () => channel, removeChannel: async () => {} } };
});
vi.mock("@/lib/sales-report.functions", () => ({
  getSalesReportFn: vi.fn(),
  emailSalesReportFn: vi.fn(),
}));

import { LiveSales } from "@/components/admin/reports/LiveSales";
import { SalesReportsPanel } from "@/components/admin/reports/SalesReportsPanel";
import { renderTemplate } from "@/lib/notifications/templates";
import { rangeFor, salesReportCsv, type SalesReport } from "@/lib/sales-report-logic";

const report = (o: Partial<SalesReport> = {}): SalesReport => ({
  from: "2026-10-27",
  to: "2026-10-27",
  generated_at: "2026-10-27T10:00:00Z",
  total: 650,
  transactions: 3,
  average_sale: 216.67,
  pos: {
    count: 2,
    gross: 400,
    refunds: 50,
    refund_count: 1,
    voided_count: 0,
    voided_total: 0,
    net: 350,
  },
  online: {
    count: 1,
    total: 300,
    delivery_fees: 0,
    awaiting_count: 1,
    awaiting_total: 120,
    cancelled_count: 0,
    pickup_count: 1,
  },
  daily: [{ day: "2026-10-27", pos: 350, online: 300 }],
  hourly: Array.from({ length: 24 }, (_, hour) => ({
    hour,
    pos: hour === 11 ? 400 : 0,
    online: 0,
    count: hour === 11 ? 2 : 0,
  })),
  pos_tenders: { cash: 150, card: 250 },
  online_methods: { eft: 300 },
  products: [{ name: "Thai Haze", category: "Flower", qty: 3, revenue: 360, pos: 360, online: 0 }],
  categories: [{ category: "Flower", qty: 3, revenue: 360 }],
  cashiers: [{ name: "Aidan", count: 2, total: 400 }],
  recent: [
    {
      channel: "pos",
      ref: "POS-271026-000038",
      amount: 200,
      status: "completed",
      at: "2026-10-27T09:30:00Z",
      method: "card",
    },
    {
      channel: "online",
      ref: "CP-2710-0001",
      amount: 300,
      status: "confirmed",
      at: "2026-10-27T09:00:00Z",
      method: "eft",
    },
  ],
  ...o,
});

afterEach(() => {
  cleanup();
  handlers.length = 0;
});

describe("live sales on the overview", () => {
  it("shows today's till and online sales and the latest transactions", async () => {
    render(<LiveSales load={vi.fn(async () => report())} />);
    expect((await screen.findAllByText("R650")).length).toBeGreaterThan(0);
    expect(screen.getByText("R350")).toBeTruthy(); // till net
    expect(screen.getByText(/1 awaiting payment/)).toBeTruthy();
    expect(screen.getByText("POS-271026-000038")).toBeTruthy();
    expect(screen.getByText("CP-2710-0001")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/Live/);
  });

  it("reloads as soon as a till sale or order changes", async () => {
    const load = vi.fn(async () => report());
    render(<LiveSales load={load} />);
    await screen.findAllByText("R650");
    const before = load.mock.calls.length;
    load.mockResolvedValue(report({ total: 900 }));
    handlers.forEach((h) => h());
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(before));
    expect((await screen.findAllByText("R900")).length).toBeGreaterThan(0);
  });
});

describe("Reports tab", () => {
  it("shows totals, products, staff and methods, and managers can email the day", async () => {
    const user = userEvent.setup();
    const email = vi.fn(async () => ({ recipients: 3 }));
    render(<SalesReportsPanel canEmail load={vi.fn(async () => report())} email={email} />);
    expect(await screen.findByText("Thai Haze")).toBeTruthy();
    expect(screen.getByText("Aidan")).toBeTruthy();
    expect(screen.getByText(/peak 11:00–12:00/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Email to managers/ }));
    await waitFor(() => expect(email).toHaveBeenCalled());
    expect(await screen.findByText(/to 3 managers and admins/)).toBeTruthy();
  });

  it("budtenders cannot email the report", async () => {
    render(<SalesReportsPanel canEmail={false} load={vi.fn(async () => report())} />);
    await screen.findByText("Thai Haze");
    expect(screen.queryByRole("button", { name: /Email to managers/ })).toBeNull();
  });
});

describe("report helpers and email", () => {
  it("works out periods in South African days", () => {
    expect(rangeFor("yesterday", "2026-11-01")).toEqual({ from: "2026-10-31", to: "2026-10-31" });
    expect(rangeFor("7d", "2026-10-27")).toEqual({ from: "2026-10-21", to: "2026-10-27" });
    expect(rangeFor("last-month", "2026-10-27")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(rangeFor("month", "2026-10-27")).toEqual({ from: "2026-10-01", to: "2026-10-27" });
  });

  it("exports CSV with the summary, days, products and staff", () => {
    const csv = salesReportCsv(report());
    expect(csv).toContain("Total sales,650.00");
    expect(csv).toContain("Thai Haze,Flower,3,360.00");
    expect(csv).toContain("Aidan,2,400.00");
  });

  it("renders the daily email with totals only", () => {
    const r = report();
    const out = renderTemplate(
      "staff_daily_sales",
      {
        day: r.from,
        total: r.total,
        transactions: r.transactions,
        average_sale: r.average_sale,
        pos: r.pos,
        online: r.online,
        pos_tenders: r.pos_tenders,
        online_methods: r.online_methods,
        products: r.products,
      },
      { siteUrl: "https://cannaplug012.co.za" } as never,
    )!;
    expect(out.subject).toMatch(/^Sales report 2026-10-27: R650[.,]00$/);
    expect(out.text).toMatch(/Till|In store/);
    expect(out.text).toMatch(/Thai Haze/);
    expect(out.html).toContain("/admin#reports");
  });
});
