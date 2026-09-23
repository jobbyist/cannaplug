import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  AlertTriangle, Bell, Boxes, Calendar, CircleUserRound, ClipboardList,
  Cog, Leaf, LayoutDashboard, Megaphone, Newspaper, Package, PlusCircle,
  Search, ShoppingBag, Truck, Users, Wallet,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { DashboardSidebar, type SidebarItem } from "@/components/dashboard/Sidebar";
import { useAuth } from "@/hooks/useAuth";
import { rand } from "@/lib/cart";
import { adminOrders, adminStats, inventoryStatus, lowStockAlerts, products, recentActivity, salesOverview, topProducts } from "@/lib/mock-data";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin Dashboard | CannaPlug" }] }),
  component: AdminPage,
});

const NAV_ITEMS: SidebarItem[] = [
  { id: "overview", icon: LayoutDashboard, label: "Overview" },
  { id: "orders", icon: ClipboardList, label: "Orders" },
  { id: "products", icon: Package, label: "Products" },
  { id: "inventory", icon: Boxes, label: "Inventory" },
  { id: "customers", icon: Users, label: "Customers" },
  { id: "deliveries", icon: Truck, label: "Deliveries" },
  { id: "promotions", icon: Megaphone, label: "Promotions" },
  { id: "events", icon: Calendar, label: "Events" },
  { id: "newsroom", icon: Newspaper, label: "Newsroom" },
  { id: "reports", icon: Wallet, label: "Reports" },
  { id: "settings", icon: Cog, label: "Settings" },
];

const statusVariant = (status: string) =>
  status === "Delivered" ? "default" : status === "Cancelled" ? "destructive" : "secondary";

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="grid h-64 place-items-center rounded-xl border border-dashed border-border text-center">
      <div>
        <p className="font-display text-sm font-bold uppercase">{label}</p>
        <p className="mt-1 text-xs text-muted-foreground">This module connects to Supabase in a future iteration.</p>
      </div>
    </div>
  );
}

function AdminPage() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState("overview");

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <p className="text-sm text-muted-foreground">Loading admin dashboard…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-4">
        <div className="max-w-sm text-center">
          <p className="font-display text-xl font-bold uppercase">Admin sign-in required</p>
          <p className="mt-2 text-sm text-muted-foreground">Sign in to a staff account to access the CannaPlug dashboard.</p>
          <Link to="/account"><span className="mt-4 inline-flex items-center justify-center rounded-full bg-primary px-5 py-2.5 text-xs font-semibold uppercase text-primary-foreground">Sign in</span></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="site flex min-h-screen flex-col bg-background md:flex-row">
      <DashboardSidebar
        items={NAV_ITEMS}
        active={tab}
        onSelect={setTab}
        header={
          <Link to="/" className="flex items-center gap-2 font-display text-base font-bold text-primary">
            <Leaf size={19} /> CANNA<span className="text-foreground">PLUG</span>
          </Link>
        }
      />

      <main className="flex-1 overflow-y-auto px-4 pb-24 pt-6 sm:px-8 sm:pt-8 md:pb-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
            <Input className="pl-9" placeholder="Search orders, customers, products…" />
          </div>
          <div className="flex items-center gap-3">
            <button aria-label="Notifications" className="relative grid h-9 w-9 place-items-center rounded-full border border-border">
              <Bell size={16} />
              <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-destructive" />
            </button>
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-primary text-primary-foreground"><CircleUserRound size={18} /></span>
              <div className="hidden text-xs sm:block">
                <p className="font-semibold">Admin</p>
                <p className="text-muted-foreground">{user.email ?? "Store Admin"}</p>
              </div>
            </div>
          </div>
        </header>

        {tab === "overview" && (
          <div className="flex flex-col gap-6">
            <div>
              <h1 className="font-display text-2xl font-extrabold uppercase">Overview</h1>
              <p className="text-sm text-muted-foreground">Your dispensary at a glance</p>
            </div>

            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { icon: ShoppingBag, label: "Total Orders", value: adminStats.totalOrders.toLocaleString("en-ZA"), tone: "text-primary" },
                { icon: Wallet, label: "Revenue", value: rand(adminStats.revenueRand), tone: "text-primary" },
                { icon: AlertTriangle, label: "Inventory Alerts", value: adminStats.inventoryAlerts, tone: "text-destructive" },
                { icon: Users, label: "Total Customers", value: adminStats.totalCustomers.toLocaleString("en-ZA"), tone: "text-primary" },
              ].map((stat) => (
                <div key={stat.label} className="rounded-xl border border-border bg-card p-5">
                  <div className="flex items-center gap-3">
                    <span className={`grid h-11 w-11 place-items-center rounded-full border border-current/20 ${stat.tone}`}><stat.icon size={19} /></span>
                    <div>
                      <p className="text-xs text-muted-foreground">{stat.label}</p>
                      <p className="font-display text-xl font-extrabold">{stat.value}</p>
                    </div>
                  </div>
                </div>
              ))}
            </section>

            <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="font-display text-sm font-bold uppercase">Sales overview</h2>
                  <span className="text-xs text-muted-foreground">Last 7 days</span>
                </div>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={salesOverview}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                      <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" />
                      <YAxis tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" tickFormatter={(v) => `${v / 1000}k`} />
                      <Tooltip formatter={(value: number) => rand(value)} cursor={{ fill: "var(--muted)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 }} />
                      <Bar dataKey="value" radius={[6, 6, 0, 0]} fill="var(--primary)" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="mb-4 font-display text-sm font-bold uppercase">Top performing products</h2>
                <ul className="flex flex-col gap-3">
                  {topProducts.map((p, i) => (
                    <li key={p.name} className="flex items-center gap-3 text-xs">
                      <span className="grid h-7 w-7 place-items-center rounded-full bg-secondary text-[0.65rem] font-bold text-primary">{i + 1}</span>
                      <span className="flex-1 font-semibold">{p.name}</span>
                      <span className="text-muted-foreground">{p.sold} sold</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="font-display text-sm font-bold uppercase">Recent orders</h2>
                  <button onClick={() => setTab("orders")} className="text-xs font-semibold text-primary">View all</button>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Order ID</TableHead><TableHead>Customer</TableHead><TableHead>Total</TableHead><TableHead>Status</TableHead><TableHead>Date</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {adminOrders.map((order) => (
                      <TableRow key={order.orderId}>
                        <TableCell className="font-medium">{order.orderId}</TableCell>
                        <TableCell>{order.customer}</TableCell>
                        <TableCell>{rand(order.total)}</TableCell>
                        <TableCell><Badge variant={statusVariant(order.status)}>{order.status}</Badge></TableCell>
                        <TableCell className="text-muted-foreground">{order.date}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex flex-col gap-6">
                <div className="rounded-xl border border-border bg-card p-5">
                  <h2 className="mb-3 font-display text-sm font-bold uppercase">Quick actions</h2>
                  <div className="flex flex-col gap-2 text-sm">
                    <button className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-left hover:border-primary"><PlusCircle size={15} className="text-primary" /> Add product</button>
                    <button className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-left hover:border-primary"><Megaphone size={15} className="text-primary" /> Create promotion</button>
                    <button onClick={() => setTab("reports")} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-left hover:border-primary"><ClipboardList size={15} className="text-primary" /> View reports</button>
                    <button onClick={() => setTab("events")} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-left hover:border-primary"><Calendar size={15} className="text-primary" /> Manage events</button>
                  </div>
                </div>
              </div>
            </section>

            <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="mb-3 font-display text-sm font-bold uppercase">Inventory status</h2>
                <ul className="flex flex-col gap-3">
                  {inventoryStatus.map((item) => (
                    <li key={item.name}>
                      <div className="mb-1 flex justify-between text-xs"><span>{item.name}</span><span className="text-muted-foreground">{item.percent}%</span></div>
                      <Progress value={item.percent} />
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="mb-3 font-display text-sm font-bold uppercase">Low stock alerts</h2>
                <ul className="flex flex-col gap-2 text-xs">
                  {lowStockAlerts.map((alert) => (
                    <li key={alert} className="flex items-center gap-2 text-destructive"><AlertTriangle size={13} />{alert}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="mb-3 font-display text-sm font-bold uppercase">Recent activity</h2>
                <ul className="flex flex-col gap-3 text-xs">
                  {recentActivity.map((activity) => (
                    <li key={activity.label} className="flex items-center justify-between"><span>{activity.label}</span><span className="text-muted-foreground">{activity.time}</span></li>
                  ))}
                </ul>
              </div>
            </section>
          </div>
        )}

        {tab === "orders" && (
          <div>
            <h1 className="mb-4 font-display text-xl font-extrabold uppercase">Orders</h1>
            <Table>
              <TableHeader>
                <TableRow><TableHead>Order ID</TableHead><TableHead>Customer</TableHead><TableHead>Total</TableHead><TableHead>Status</TableHead><TableHead>Date</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {adminOrders.map((order) => (
                  <TableRow key={order.orderId}>
                    <TableCell className="font-medium">{order.orderId}</TableCell>
                    <TableCell>{order.customer}</TableCell>
                    <TableCell>{rand(order.total)}</TableCell>
                    <TableCell><Badge variant={statusVariant(order.status)}>{order.status}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{order.date}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {tab === "products" && (
          <div>
            <h1 className="mb-4 font-display text-xl font-extrabold uppercase">Products</h1>
            <Table>
              <TableHeader>
                <TableRow><TableHead>Name</TableHead><TableHead>Category</TableHead><TableHead>Price</TableHead><TableHead>Badge</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>{p.category}</TableCell>
                    <TableCell>{rand(p.price_rand)}</TableCell>
                    <TableCell>{p.badge ? <Badge variant="outline">{p.badge}</Badge> : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {tab === "customers" && (
          <div>
            <h1 className="mb-4 font-display text-xl font-extrabold uppercase">Customers</h1>
            <Table>
              <TableHeader>
                <TableRow><TableHead>Customer</TableHead><TableHead>Orders</TableHead><TableHead>Status</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {adminOrders.map((order) => (
                  <TableRow key={order.orderId}>
                    <TableCell className="font-medium">{order.customer}</TableCell>
                    <TableCell>{Math.max(1, Math.round(order.total / 400))}</TableCell>
                    <TableCell><Badge variant="secondary">Active</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {["inventory", "deliveries", "promotions", "events", "newsroom", "reports", "settings"].includes(tab) && (
          <div>
            <h1 className="mb-4 font-display text-xl font-extrabold uppercase capitalize">{tab}</h1>
            <ComingSoon label={NAV_ITEMS.find((item) => item.id === tab)?.label ?? tab} />
          </div>
        )}
      </main>
    </div>
  );
}
