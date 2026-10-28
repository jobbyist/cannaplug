import { AlertTriangle, ShoppingBag, Users, type LucideIcon } from "lucide-react";
import { LiveSales } from "@/components/admin/reports/LiveSales";
import { OrderTable } from "@/components/admin/orders/OrdersPanel";
import { rand } from "@/lib/cart";
import type { AdminDashboard } from "@/lib/admin-data.server";

const compact = (n: number) => n.toLocaleString("en-ZA");

function MoneyCard({
  label,
  m,
}: {
  label: string;
  m: AdminDashboard["stats"]["revenue"]["today"];
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-display text-xl font-extrabold">{rand(m.total)}</p>
      <p className="mt-1 text-[0.68rem] text-muted-foreground">
        Till {rand(m.pos)} · Online {rand(m.online)}
      </p>
    </div>
  );
}

/** The 7-day chart: till and online sales stacked, by South African day. Plain CSS bars, readable by screen readers. */
export function SalesChart({ days }: { days: AdminDashboard["salesOverview"] }) {
  const max = Math.max(1, ...days.map((d) => d.total));
  return (
    <figure aria-label="Sales for the last 7 days">
      <div className="flex h-36 items-end gap-2" role="list">
        {days.map((d) => (
          <div
            key={d.day}
            role="listitem"
            className="flex h-full flex-1 flex-col justify-end"
            title={`${d.label}: ${rand(d.total)} (till ${rand(d.pos)}, online ${rand(d.online)})`}
          >
            <div
              className="w-full rounded-t bg-primary/60"
              style={{ height: `${(d.online / max) * 100}%` }}
              aria-hidden
            />
            <div
              className="w-full bg-primary"
              style={{ height: `${(d.pos / max) * 100}%` }}
              aria-hidden
            />
            <span className="sr-only">
              {d.label}: {rand(d.total)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2 text-[0.65rem] text-muted-foreground" aria-hidden>
        {days.map((d) => (
          <span key={d.day} className="flex-1 text-center">
            {d.label}
          </span>
        ))}
      </div>
      <figcaption className="mt-3 flex gap-4 text-[0.65rem] text-muted-foreground">
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm bg-primary" /> Till
        </span>
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm bg-primary/60" /> Online
        </span>
      </figcaption>
    </figure>
  );
}

/** The Overview tab. Money is for managers and admins (the same numbers as Reports); everyone sees the counts. */
export function OverviewPanel({
  dashboard,
  canSeeMoney,
  onViewOrders,
  onSelectOrder,
}: {
  dashboard: AdminDashboard;
  canSeeMoney: boolean;
  onViewOrders: () => void;
  onSelectOrder: (id: string) => void;
}) {
  const { stats } = dashboard;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-extrabold uppercase">Overview</h1>
        <p className="text-sm text-muted-foreground">Live dispensary operations</p>
      </div>
      <LiveSales />
      {canSeeMoney && (
        <>
          <section
            aria-label="Revenue"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
          >
            <MoneyCard label="Today" m={stats.revenue.today} />
            <MoneyCard label="Last 7 days" m={stats.revenue.week} />
            <MoneyCard label="This month" m={stats.revenue.month} />
            <MoneyCard label="All time" m={stats.revenue.allTime} />
          </section>
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 font-display text-sm font-bold uppercase">Sales, last 7 days</h2>
            <SalesChart days={dashboard.salesOverview} />
          </section>
        </>
      )}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {(
          [
            [ShoppingBag, "Total sales (online + till)", compact(stats.totalSales)],
            [AlertTriangle, "Low-stock products", stats.inventoryAlerts],
            [Users, "Members", compact(stats.totalCustomers)],
          ] as [LucideIcon, string, string | number][]
        ).map(([Icon, label, value]) => (
          <div key={label} className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-full border border-primary/20 text-primary">
                <Icon size={19} />
              </span>
              <div>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="font-display text-xl font-extrabold">{value}</p>
              </div>
            </div>
          </div>
        ))}
      </section>
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-1 font-display text-sm font-bold uppercase">Best sellers</h2>
          <p className="mb-3 text-[0.68rem] text-muted-foreground">
            Last 30 days, online and till together
          </p>
          {dashboard.topProducts.length === 0 && (
            <p className="text-xs text-muted-foreground">No sales yet.</p>
          )}
          {dashboard.topProducts.map((p, i) => (
            <div key={p.name} className="flex items-center gap-3 py-2 text-xs">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-secondary text-[0.65rem] font-bold text-primary">
                {i + 1}
              </span>
              <span className="flex-1 font-semibold">{p.name}</span>
              <span className="text-muted-foreground">{compact(p.sold)} sold</span>
            </div>
          ))}
        </div>
      </section>
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-sm font-bold uppercase">Recent orders</h2>
            <button onClick={onViewOrders} className="text-xs font-semibold text-primary">
              View all
            </button>
          </div>
          <OrderTable orders={dashboard.recentOrders} onSelect={onSelectOrder} />
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 font-display text-sm font-bold uppercase">Recent activity</h2>
          {dashboard.activity.map((a) => (
            <div
              key={a.label + "-" + a.time}
              className="flex justify-between gap-3 border-b border-border py-2 text-xs last:border-0"
            >
              <span>{a.label}</span>
              <span className="text-muted-foreground">{a.time}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
