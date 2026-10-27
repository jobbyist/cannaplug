import { useMemo } from "react";
import { Globe, Radio, Receipt, ShoppingBag, Store, TrendingUp } from "lucide-react";
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
import { rand } from "@/lib/cart";
import { addDays, methodLabel, n, sastDay, type SalesReport } from "@/lib/sales-report-logic";
import { useSalesReport, type ReportLoader } from "./useSalesReport";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Johannesburg",
  });
const weekday = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-ZA", { weekday: "short", timeZone: "UTC" });

export const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  voided: "Voided",
  partially_refunded: "Part refunded",
  refunded: "Refunded",
  awaiting_payment: "Awaiting payment",
  confirmed: "Paid",
  packing: "Packing",
  ready: "Ready",
  out_for_delivery: "Out for delivery",
  cancelled: "Cancelled",
};

function Kpi({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Store;
  label: string;
  value: string;
  hint?: string | undefined;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="flex items-center gap-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">
        <Icon size={13} className="text-primary" /> {label}
      </p>
      <p className="mt-1 font-display text-2xl font-extrabold">{value}</p>
      {hint && <p className="text-[0.7rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Live feed of the latest till sales and online orders (receipt / order numbers only). */
export function SalesFeed({ report }: { report: SalesReport }) {
  if (!report.recent.length)
    return <p className="py-6 text-center text-xs text-muted-foreground">No sales yet today.</p>;
  return (
    <ul className="divide-y divide-border text-xs" aria-label="Latest sales">
      {report.recent.map((t) => (
        <li key={`${t.channel}-${t.ref}`} className="flex items-center justify-between gap-2 py-2">
          <span className="flex min-w-0 items-center gap-2">
            {t.channel === "pos" ? (
              <Store size={14} className="shrink-0 text-primary" />
            ) : (
              <Globe size={14} className="shrink-0 text-[#D4AF37]" />
            )}
            <span className="min-w-0">
              <span className="block truncate font-semibold">{t.ref}</span>
              <span className="block truncate text-muted-foreground">
                {time(t.at)} · {t.channel === "pos" ? "Till" : "Online"} · {methodLabel(t.method)}
              </span>
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span
              className={`block font-bold ${["voided", "cancelled", "refunded"].includes(t.status) ? "text-muted-foreground line-through" : ""}`}
            >
              {rand(n(t.amount))}
            </span>
            <span className="block text-[0.65rem] text-muted-foreground">
              {STATUS_LABEL[t.status] ?? t.status}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Overview: today's till and online sales, updating live for every staff member, plus the last 7 days.
 * Till sales come from the POS; online sales count once an order is paid.
 */
export function LiveSales({ load }: { load?: ReportLoader }) {
  const today = sastDay();
  const opts = load ? { load } : {};
  const live = useSalesReport(today, today, opts);
  const week = useSalesReport(addDays(today, -6), today, opts);
  const r = live.report;
  const chart = useMemo(
    () =>
      (week.report?.daily ?? []).map((d) => ({
        day: weekday(d.day),
        Till: n(d.pos),
        Online: n(d.online),
      })),
    [week.report],
  );
  const weekTotal = (week.report?.daily ?? []).reduce((s, d) => s + n(d.pos) + n(d.online), 0);

  return (
    <section className="grid gap-4" aria-label="Live sales">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-sm font-bold uppercase">Today's sales</h2>
        <span
          className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground"
          role="status"
        >
          <Radio size={12} className={live.connected ? "text-primary" : "text-muted-foreground"} />
          {live.connected ? "Live" : "Auto-refresh"}
          {live.updatedAt &&
            ` · updated ${live.updatedAt.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`}
        </span>
      </div>
      {live.error && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {live.error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi
          icon={TrendingUp}
          label="Total today"
          value={r ? rand(n(r.total)) : "…"}
          hint={r ? `${r.transactions} sales` : undefined}
        />
        <Kpi
          icon={Store}
          label="Till (net)"
          value={r ? rand(n(r.pos.net)) : "…"}
          hint={
            r
              ? `${r.pos.count} sales${n(r.pos.refunds) ? ` · ${rand(n(r.pos.refunds))} refunded` : ""}`
              : undefined
          }
        />
        <Kpi
          icon={Globe}
          label="Online (paid)"
          value={r ? rand(n(r.online.total)) : "…"}
          hint={
            r
              ? `${r.online.count} orders${r.online.awaiting_count ? ` · ${r.online.awaiting_count} awaiting payment` : ""}`
              : undefined
          }
        />
        <Kpi icon={Receipt} label="Average sale" value={r ? rand(n(r.average_sale)) : "…"} />
        <Kpi
          icon={ShoppingBag}
          label="Payments"
          value={
            r
              ? Object.entries(r.pos_tenders)
                  .map(([k, v]) => `${methodLabel(k)} ${rand(n(v))}`)
                  .join(" · ") || "—"
              : "…"
          }
          hint="Till, by method"
        />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-sm font-bold uppercase">Last 7 days</h3>
            <span className="text-xs text-muted-foreground">{rand(weekTotal)}</span>
          </div>
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={11} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  fontSize={11}
                  tickFormatter={(v: number) => (v >= 1000 ? `${v / 1000}k` : String(v))}
                />
                <Tooltip formatter={(value: number) => rand(value)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Till" stackId="s" fill="#0B3D20" radius={[0, 0, 0, 0]} />
                <Bar dataKey="Online" stackId="s" fill="#D4AF37" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="mb-2 font-display text-sm font-bold uppercase">Latest sales</h3>
          {r ? <SalesFeed report={r} /> : <p className="text-xs text-muted-foreground">Loading…</p>}
        </div>
      </div>
    </section>
  );
}
