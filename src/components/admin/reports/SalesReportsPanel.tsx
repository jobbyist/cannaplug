import { useMemo, useRef, useState } from "react";
import { Download, FileSpreadsheet, FileText, FileType2, Mail, RefreshCw } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { rand } from "@/lib/cart";
import { emailSalesReportFn } from "@/lib/sales-report.functions";
import {
  RANGE_LABEL,
  methodLabel,
  n,
  rangeFor,
  salesReportCsv,
  sastDay,
  type RangeKey,
} from "@/lib/sales-report-logic";
import { reportFileName } from "@/lib/sales-report-export";
import { SalesFeed } from "./LiveSales";
import { useSalesReport, type ReportLoader } from "./useSalesReport";

export type EmailReport = (day: string, key: string) => Promise<{ recipients: number }>;
const serverEmail: EmailReport = (day, key) =>
  emailSalesReportFn({ data: { day, key } }) as Promise<{ recipients: number }>;

const dayLabel = (day: string, long = false) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "short",
    ...(long ? { weekday: "short" } : {}),
    timeZone: "UTC",
  });

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-display text-xl font-extrabold">{value}</p>
      {hint && <p className="text-[0.7rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Card({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-border bg-card p-5 ${className}`}>
      <h3 className="mb-3 font-display text-sm font-bold uppercase">{title}</h3>
      {children}
    </div>
  );
}

function Breakdown({ rows }: { rows: [string, number][] }) {
  const total = rows.reduce((s, [, v]) => s + v, 0);
  if (!rows.length) return <p className="text-xs text-muted-foreground">Nothing in this period.</p>;
  return (
    <ul className="grid gap-2 text-xs">
      {rows.map(([label, v]) => (
        <li key={label}>
          <div className="flex justify-between">
            <span className="font-semibold">{label}</span>
            <span>
              {rand(v)}{" "}
              <span className="text-muted-foreground">
                ({total ? Math.round((v / total) * 100) : 0}%)
              </span>
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary"
              style={{ width: `${total ? (v / total) * 100 : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * /admin → Reports: sales for any period (till and online together), by day, hour, payment method, product,
 * category and staff member, with a CSV download. Managers can email a day's report to managers and admins.
 */
export function SalesReportsPanel({
  canEmail,
  load,
  email = serverEmail,
}: {
  canEmail: boolean;
  load?: ReportLoader;
  email?: EmailReport;
}) {
  const [range, setRange] = useState<RangeKey>("today");
  const [custom, setCustom] = useState(() => ({ from: sastDay(), to: sastDay() }));
  const { from, to } = range === "custom" ? custom : rangeFor(range);
  const validCustom = range !== "custom" || (custom.from && custom.to && custom.from <= custom.to);
  const {
    report: r,
    error,
    updatedAt,
    refresh,
  } = useSalesReport(validCustom ? from : sastDay(), validCustom ? to : sastDay(), {
    live: range === "today" || range === "7d" || range === "30d" || range === "month",
    ...(load ? { load } : {}),
  });
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const emailKey = useRef<{ day: string; key: string } | null>(null);
  const singleDay = from === to;

  const daily = useMemo(
    () =>
      (r?.daily ?? []).map((d) => ({ day: dayLabel(d.day), Till: n(d.pos), Online: n(d.online) })),
    [r],
  );
  const hourly = useMemo(
    () =>
      (r?.hourly ?? [])
        .filter((h) => h.hour >= 7 && h.hour <= 22)
        .map((h) => ({
          hour: `${String(h.hour).padStart(2, "0")}:00`,
          Till: n(h.pos),
          Online: n(h.online),
        })),
    [r],
  );
  const busiest = useMemo(() => {
    const h = [...(r?.hourly ?? [])].sort(
      (a, b) => n(b.pos) + n(b.online) - (n(a.pos) + n(a.online)),
    )[0];
    return h && n(h.pos) + n(h.online) > 0
      ? `${String(h.hour).padStart(2, "0")}:00–${String(h.hour + 1).padStart(2, "0")}:00`
      : "—";
  }, [r]);

  const [exporting, setExporting] = useState<string | null>(null);
  const exportAs = async (format: "pdf" | "docx" | "xlsx") => {
    if (!r || exporting) return;
    setExporting(format);
    setNote(null);
    try {
      const { downloadReport } = await import("@/lib/sales-report-files");
      await downloadReport(r, format, reportFileName(r, format));
    } catch {
      setNote("Could not create that file. Please try again or use another format.");
    } finally {
      setExporting(null);
    }
  };
  const download = () => {
    if (!r) return;
    const blob = new Blob([salesReportCsv(r)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cannaplug-sales-${r.from}${r.from === r.to ? "" : `-to-${r.to}`}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const sendEmail = async () => {
    setSending(true);
    setNote(null);
    if (!emailKey.current || emailKey.current.day !== from)
      emailKey.current = { day: from, key: crypto.randomUUID() };
    try {
      const res = await email(from, emailKey.current.key);
      emailKey.current = null;
      setNote(
        `Sent the ${dayLabel(from, true)} report to ${res.recipients} manager${res.recipients === 1 ? "" : "s"} and admins.`,
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not send the report.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-extrabold uppercase">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Till and online sales together. Online orders count once paid. Times are South African.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
            <SelectTrigger aria-label="Period" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(RANGE_LABEL) as RangeKey[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {RANGE_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {range === "custom" && (
            <>
              <Input
                type="date"
                aria-label="From"
                className="w-40"
                value={custom.from}
                max={sastDay()}
                onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              />
              <Input
                type="date"
                aria-label="To"
                className="w-40"
                value={custom.to}
                max={sastDay()}
                onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              />
            </>
          )}
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw size={14} /> Refresh
          </Button>
          <div role="group" aria-label="Download report" className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void exportAs("pdf")}
              disabled={!r || !!exporting}
            >
              <FileText size={14} /> {exporting === "pdf" ? "Making PDF…" : "PDF"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void exportAs("docx")}
              disabled={!r || !!exporting}
            >
              <FileType2 size={14} /> {exporting === "docx" ? "Making Word…" : "Word"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void exportAs("xlsx")}
              disabled={!r || !!exporting}
            >
              <FileSpreadsheet size={14} /> {exporting === "xlsx" ? "Making Excel…" : "Excel"}
            </Button>
            <Button variant="outline" size="sm" onClick={download} disabled={!r}>
              <Download size={14} /> CSV
            </Button>
          </div>
          {canEmail && singleDay && (
            <Button size="sm" onClick={() => void sendEmail()} disabled={sending || !r}>
              <Mail size={14} /> Email to managers
            </Button>
          )}
        </div>
      </div>
      {!validCustom && (
        <p className="text-xs text-destructive">Choose a start date on or before the end date.</p>
      )}
      {note && (
        <p role="status" className="rounded-lg bg-primary/5 px-3 py-2 text-xs text-primary">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {!r ? (
        <p className="text-sm text-muted-foreground">Loading report…</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {singleDay
              ? dayLabel(r.from, true)
              : `${dayLabel(r.from, true)} – ${dayLabel(r.to, true)}`}
            {updatedAt &&
              ` · updated ${updatedAt.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}`}
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Total sales" value={rand(n(r.total))} hint={`${r.transactions} sales`} />
            <Stat label="Till (net)" value={rand(n(r.pos.net))} hint={`${r.pos.count} sales`} />
            <Stat
              label="Online (paid)"
              value={rand(n(r.online.total))}
              hint={`${r.online.count} orders`}
            />
            <Stat label="Average sale" value={rand(n(r.average_sale))} />
            <Stat
              label="Refunds & voids"
              value={rand(n(r.pos.refunds))}
              hint={`${r.pos.refund_count} refunds · ${r.pos.voided_count} voided (${rand(n(r.pos.voided_total))})`}
            />
            <Stat
              label="Unpaid online"
              value={rand(n(r.online.awaiting_total))}
              hint={`${r.online.awaiting_count} awaiting · ${r.online.cancelled_count} cancelled`}
            />
            {r.pos.discounts != null && (
              <Stat
                label="Till discounts"
                value={rand(n(r.pos.discounts))}
                hint={`${r.pos.discounted_count ?? 0} discounted sales · before discounts ${rand(n(r.pos.before_discounts))}`}
              />
            )}
            {r.till && (
              <Stat
                label="Till expenses"
                value={rand(n(r.till.expenses_recorded))}
                hint={`${r.expenses?.length ?? 0} paid from the till`}
              />
            )}
            {r.till && (
              <Stat
                label="Cash deposited"
                value={rand(n(r.till.deposited))}
                hint={`Float carried ${rand(n(r.till.float_carried))}`}
              />
            )}
            {r.till && (
              <Stat
                label="Cash variance"
                value={rand(n(r.till.variance))}
                hint={`${r.till.sessions_closed} tills closed · ${r.till.variances_pending} awaiting approval`}
              />
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {!singleDay && (
              <Card title="Sales by day" className="lg:col-span-2">
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={daily}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        vertical={false}
                        stroke="var(--border)"
                      />
                      <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={11} />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        fontSize={11}
                        tickFormatter={(v: number) => (v >= 1000 ? `${v / 1000}k` : String(v))}
                      />
                      <Tooltip formatter={(value: number) => rand(value)} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="Till" stackId="s" fill="#0B3D20" />
                      <Bar dataKey="Online" stackId="s" fill="#D4AF37" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            )}
            <Card title={`Busiest hours · peak ${busiest}`}>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hourly}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="hour" tickLine={false} axisLine={false} fontSize={10} />
                    <YAxis tickLine={false} axisLine={false} fontSize={10} />
                    <Tooltip formatter={(value: number) => rand(value)} />
                    <Bar dataKey="Till" stackId="s" fill="#0B3D20" />
                    <Bar dataKey="Online" stackId="s" fill="#D4AF37" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="Payment methods">
              <p className="mb-2 text-[0.65rem] font-bold uppercase text-muted-foreground">Till</p>
              <Breakdown
                rows={Object.entries(r.pos_tenders).map(([k, v]) => [methodLabel(k), n(v)])}
              />
              <p className="mb-2 mt-4 text-[0.65rem] font-bold uppercase text-muted-foreground">
                Online
              </p>
              <Breakdown
                rows={Object.entries(r.online_methods).map(([k, v]) => [methodLabel(k), n(v)])}
              />
            </Card>
            <Card title="Top products" className="lg:col-span-2">
              {r.products.length === 0 ? (
                <p className="text-xs text-muted-foreground">No products sold in this period.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Till</TableHead>
                      <TableHead className="text-right">Online</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.products.map((p, i) => (
                      <TableRow key={p.name}>
                        <TableCell>{i + 1}</TableCell>
                        <TableCell className="font-semibold">{p.name}</TableCell>
                        <TableCell>{p.category ?? "—"}</TableCell>
                        <TableCell className="text-right">{p.qty}</TableCell>
                        <TableCell className="text-right">{rand(n(p.pos))}</TableCell>
                        <TableCell className="text-right">{rand(n(p.online))}</TableCell>
                        <TableCell className="text-right font-semibold">
                          {rand(n(p.revenue))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>
            <Card title="Categories">
              <Breakdown rows={r.categories.map((c) => [c.category, n(c.revenue)])} />
            </Card>
            <Card title="Till sales by staff">
              {r.cashiers.length === 0 ? (
                <p className="text-xs text-muted-foreground">No till sales in this period.</p>
              ) : (
                <ul className="divide-y divide-border text-xs">
                  {r.cashiers.map((c) => (
                    <li key={c.name} className="flex justify-between py-2">
                      <span className="font-semibold">{c.name}</span>
                      <span>
                        {c.count} sales · <b>{rand(n(c.total))}</b>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {r.till && (
              <Card title="Till cash-up" className="lg:col-span-2">
                <TillCashupSection report={r} />
              </Card>
            )}
            <Card title="Latest transactions" className="lg:col-span-2">
              <SalesFeed report={r} />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/** Closed tills in the period, reconciled line by line, and the expenses paid from them. */
function TillCashupSection({
  report: r,
}: {
  report: import("@/lib/sales-report-logic").SalesReport;
}) {
  const t = r.till!;
  const lines: [string, number, boolean?][] = [
    ["Opening floats", n(t.opening_floats)],
    ["+ Cash taken from sales (after discounts)", n(t.cash_sales)],
    ["− Cash refunds", n(t.cash_refunds)],
    ["− Till expenses", n(t.expenses)],
    ["= Expected cash", n(t.expected), true],
    ["Counted cash", n(t.counted)],
    ["Variance", n(t.variance), true],
    ["Deposited to the bank", n(t.deposited)],
    ["Float carried forward", n(t.float_carried), true],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <dl className="grid gap-1 text-xs" aria-label="Till cash-up totals">
        {lines.map(([label, v, strong]) => (
          <div
            key={label}
            className={
              "flex justify-between " + (strong ? "border-t border-border pt-1 font-bold" : "")
            }
          >
            <dt className={strong ? "" : "text-muted-foreground"}>{label}</dt>
            <dd className={label === "Variance" && v !== 0 ? "text-destructive" : ""}>{rand(v)}</dd>
          </div>
        ))}
        <p className="mt-1 text-[0.65rem] text-muted-foreground">
          Discounts are already off the sales. Expenses are recorded at the till as they happen.
        </p>
      </dl>
      <div className="grid gap-4 overflow-x-auto">
        {(r.till_sessions ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">No tills were closed in this period.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Till</TableHead>
                <TableHead className="text-right">Float</TableHead>
                <TableHead className="text-right">Cash sales</TableHead>
                <TableHead className="text-right">Expenses</TableHead>
                <TableHead className="text-right">Discounts</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead className="text-right">Counted</TableHead>
                <TableHead className="text-right">Variance</TableHead>
                <TableHead className="text-right">Deposited</TableHead>
                <TableHead>Approval</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(r.till_sessions ?? []).map((s) => (
                <TableRow key={`${s.drawer}-${s.closed_at}`}>
                  <TableCell>
                    <b>{s.drawer}</b>
                    <br />
                    <span className="text-muted-foreground">{s.cashier}</span>
                  </TableCell>
                  <TableCell className="text-right">{rand(n(s.opening_float))}</TableCell>
                  <TableCell className="text-right">{rand(n(s.cash_sales))}</TableCell>
                  <TableCell className="text-right">{rand(n(s.expenses))}</TableCell>
                  <TableCell className="text-right">{rand(n(s.discounts))}</TableCell>
                  <TableCell className="text-right">{rand(n(s.expected))}</TableCell>
                  <TableCell className="text-right">{rand(n(s.counted))}</TableCell>
                  <TableCell
                    className={
                      "text-right font-semibold " + (n(s.variance) !== 0 ? "text-destructive" : "")
                    }
                  >
                    {rand(n(s.variance))}
                  </TableCell>
                  <TableCell className="text-right">{rand(n(s.deposited))}</TableCell>
                  <TableCell>
                    {s.approval.replace("_", " ")}
                    {s.approval_note && (
                      <span className="block text-[0.65rem] text-muted-foreground">
                        {s.approval_note}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {(r.expenses ?? []).length > 0 && (
          <div>
            <p className="mb-1 text-[0.65rem] font-bold uppercase text-muted-foreground">
              Till expenses
            </p>
            <ul className="divide-y divide-border text-xs">
              {(r.expenses ?? []).map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex justify-between gap-3 py-1.5">
                  <span>
                    <b className="capitalize">{e.category}</b> · {e.description}{" "}
                    <span className="text-muted-foreground">({e.by})</span>
                  </span>
                  <b>{rand(n(e.amount))}</b>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
