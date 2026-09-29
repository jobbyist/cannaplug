import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  type LucideIcon,
  AlertTriangle,
  Bell,
  Boxes,
  Calendar,
  CircleUserRound,
  ClipboardList,
  Cog,
  LayoutDashboard,
  Megaphone,
  Newspaper,
  Package,
  PlusCircle,
  Search,
  ShoppingBag,
  Store,
  Truck,
  Users,
  Wallet,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DashboardSidebar, type SidebarItem } from "@/components/dashboard/Sidebar";
import { useAuth } from "@/hooks/useAuth";
import { rand } from "@/lib/cart";
import {
  getAdminDashboardFn,
  getAdminOrderFn,
  listAdminOrdersFn,
  listAdminProductsFn,
  listCustomersFn,
  listFulfilmentQueueFn,
  saveAdminProductFn,
  deactivateAdminProductFn,
  transitionAdminOrderFn,
} from "@/lib/admin.functions";
import type { AdminOrderStatus, AdminProductInput } from "@/lib/admin-data.server";
import { PosPanel } from "@/components/admin/pos/PosPanel";
import logoImage from "@/assets/cannaplug-logo.png";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin Dashboard | CannaPlug" }] }),
  component: AdminPage,
});

const NAV_ITEMS: SidebarItem[] = [
  { id: "overview", icon: LayoutDashboard, label: "Overview" },
  { id: "pos", icon: Store, label: "POS" },
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

const transitions: Record<AdminOrderStatus, AdminOrderStatus[]> = {
  awaiting_payment: ["confirmed", "cancelled"],
  confirmed: ["packing", "cancelled"],
  packing: ["ready"],
  ready: ["out_for_delivery"],
  out_for_delivery: ["completed"],
  completed: [],
  cancelled: [],
};
const statusLabel = (status: string) =>
  status.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
const statusVariant = (status: string) =>
  status === "completed" ? "default" : status === "cancelled" ? "destructive" : "secondary";

function AdminPage() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState("overview");
  const [dashboard, setDashboard] = useState<Awaited<
    ReturnType<typeof getAdminDashboardFn>
  > | null>(null);
  const [orders, setOrders] = useState<Awaited<ReturnType<typeof listAdminOrdersFn>>>([]);
  const [products, setProducts] = useState<Awaited<ReturnType<typeof listAdminProductsFn>>>([]);
  const [customers, setCustomers] = useState<Awaited<ReturnType<typeof listCustomersFn>>>([]);
  const [fulfilment, setFulfilment] = useState<Awaited<ReturnType<typeof listFulfilmentQueueFn>>>(
    [],
  );
  const [selectedOrder, setSelectedOrder] =
    useState<Awaited<ReturnType<typeof getAdminOrderFn>>>(null);
  const [hasMoreOrders, setHasMoreOrders] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editingProduct, setEditingProduct] = useState<string | null>(null);

  const loadMoreOrders = async () => {
    const last = orders[orders.length - 1];
    if (!last) return;
    try {
      const older = await listAdminOrdersFn({ data: { before: last.created_at } });
      setOrders((current) => [...current, ...older]);
      setHasMoreOrders(older.length >= 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load older orders.");
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const [d, o, p, c, f] = await Promise.all([
        getAdminDashboardFn(),
        listAdminOrdersFn(),
        listAdminProductsFn(),
        listCustomersFn(),
        listFulfilmentQueueFn(),
      ]);
      setDashboard(d);
      setOrders(o);
      setHasMoreOrders(o.length >= 100);
      setProducts(p);
      setCustomers(c);
      setFulfilment(f);
      if (selectedOrder)
        setSelectedOrder((await getAdminOrderFn({ data: { orderId: selectedOrder.id } })) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load admin data.");
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    if (user) void refresh();
    // Intentionally keyed on the signed-in user only; refresh() is re-created each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (loading)
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <p className="text-sm text-muted-foreground">Loading admin dashboard…</p>
      </div>
    );
  if (!user)
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <div className="text-center">
          <p className="font-display text-xl font-bold uppercase">Admin sign-in required</p>
          <Link
            to="/account"
            className="mt-4 inline-flex rounded-full bg-primary px-5 py-2.5 text-xs font-semibold uppercase text-primary-foreground"
          >
            Sign in
          </Link>
        </div>
      </div>
    );

  return (
    <div className="site flex min-h-screen flex-col bg-background md:flex-row">
      <DashboardSidebar
        items={NAV_ITEMS}
        active={tab}
        onSelect={setTab}
        header={
          <Link to="/">
            <img src={logoImage} alt="CannaPlug" className="h-6 w-auto" />
          </Link>
        }
      />
      <main className="flex-1 overflow-y-auto px-4 pb-24 pt-6 sm:px-8 sm:pt-8 md:pb-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full max-w-sm">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              size={16}
            />
            <Input className="pl-9" placeholder="Search orders, customers, products…" />
          </div>
          <div className="flex items-center gap-3">
            <button
              aria-label="Notifications"
              className="grid h-9 w-9 place-items-center rounded-full border border-border"
            >
              <Bell size={16} />
            </button>
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-primary text-primary-foreground">
                <CircleUserRound size={18} />
              </span>
              <div className="hidden text-xs sm:block">
                <p className="font-semibold">Staff</p>
                <p className="text-muted-foreground">{user.email}</p>
              </div>
            </div>
          </div>
        </header>
        {error && (
          <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
            {error}
          </div>
        )}
        {refreshing && <p className="mb-4 text-xs text-muted-foreground">Refreshing live data…</p>}

        {tab === "overview" && dashboard && (
          <div className="flex flex-col gap-6">
            <div>
              <h1 className="font-display text-2xl font-extrabold uppercase">Overview</h1>
              <p className="text-sm text-muted-foreground">Live dispensary operations</p>
            </div>
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {(
                [
                  [
                    ShoppingBag,
                    "Total Orders",
                    dashboard.stats.totalOrders.toLocaleString("en-ZA"),
                  ],
                  [Wallet, "Revenue", rand(dashboard.stats.revenueRand)],
                  [AlertTriangle, "Inventory Alerts", dashboard.stats.inventoryAlerts],
                  [
                    Users,
                    "Total Customers",
                    dashboard.stats.totalCustomers.toLocaleString("en-ZA"),
                  ],
                ] as [LucideIcon, string, string | number][]
              ).map(([Icon, label, value]) => (
                <div key={String(label)} className="rounded-xl border border-border bg-card p-5">
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
              <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="font-display text-sm font-bold uppercase">Sales overview</h2>
                  <span className="text-xs text-muted-foreground">Last 7 days</span>
                </div>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dashboard.salesOverview}>
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
                        tickFormatter={(v) => v / 1000 + "k"}
                      />
                      <Tooltip formatter={(value: number) => rand(value)} />
                      <Bar dataKey="value" radius={[6, 6, 0, 0]} fill="var(--primary)" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="mb-4 font-display text-sm font-bold uppercase">Top products</h2>
                {dashboard.topProducts.map((p, i) => (
                  <div key={p.name} className="flex items-center gap-3 py-2 text-xs">
                    <span className="grid h-7 w-7 place-items-center rounded-full bg-secondary text-[0.65rem] font-bold text-primary">
                      {i + 1}
                    </span>
                    <span className="flex-1 font-semibold">{p.name}</span>
                    <span className="text-muted-foreground">{p.sold} sold</span>
                  </div>
                ))}
              </div>
            </section>
            <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="font-display text-sm font-bold uppercase">Recent orders</h2>
                  <button
                    onClick={() => setTab("orders")}
                    className="text-xs font-semibold text-primary"
                  >
                    View all
                  </button>
                </div>
                <OrderTable
                  orders={dashboard.recentOrders}
                  onSelect={(id) => {
                    void getAdminOrderFn({ data: { orderId: id } }).then(setSelectedOrder);
                    setTab("orders");
                  }}
                />
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
        )}

        {tab === "pos" && <PosPanel customers={customers} />}
        {tab === "orders" && (
          <OrdersPanel
            orders={orders}
            {...(hasMoreOrders ? { onLoadMore: loadMoreOrders } : {})}
            selected={selectedOrder}
            onSelect={async (id) =>
              setSelectedOrder(await getAdminOrderFn({ data: { orderId: id } }))
            }
            onTransition={async (orderId, toStatus) => {
              await transitionAdminOrderFn({ data: { orderId, toStatus } });
              await refresh();
            }}
          />
        )}
        {tab === "deliveries" && (
          <OrdersPanel
            orders={fulfilment}
            selected={selectedOrder}
            onSelect={async (id) =>
              setSelectedOrder(await getAdminOrderFn({ data: { orderId: id } }))
            }
            onTransition={async (orderId, toStatus) => {
              await transitionAdminOrderFn({ data: { orderId, toStatus } });
              await refresh();
            }}
          />
        )}
        {tab === "products" && (
          <ProductsPanel
            products={products}
            editingProduct={editingProduct}
            setEditingProduct={setEditingProduct}
            onSaved={refresh}
          />
        )}
        {tab === "inventory" && dashboard && (
          <div>
            <h1 className="mb-4 font-display text-xl font-extrabold uppercase">Inventory</h1>
            <p className="mb-4 text-sm text-muted-foreground">
              Available = on hand minus stock held for unpaid online orders. Figures come from the
              immutable stock ledger and reservations; change stock in POS → Stock control.
            </p>
            <div className="grid gap-3">
              {dashboard.inventory.map((item) => (
                <div key={item.product_id} className="rounded-xl border border-border bg-card p-4">
                  <div className="mb-2 flex justify-between text-xs">
                    <span className="font-semibold">{item.product_name}</span>
                    <span>
                      {item.available} available · {item.held} held · {item.quantity_on_hand} on
                      hand · {item.batches} batches
                    </span>
                  </div>
                  <Progress value={Math.min(100, Math.max(0, item.available * 10))} />
                </div>
              ))}
            </div>
          </div>
        )}
        {tab === "customers" && (
          <div>
            <h1 className="mb-4 font-display text-xl font-extrabold uppercase">Customers</h1>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead>Spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.full_name ?? "Unnamed"}</TableCell>
                    <TableCell>{c.phone ?? "—"}</TableCell>
                    <TableCell>{c.orderCount}</TableCell>
                    <TableCell>{rand(c.spendRand)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {["promotions", "events", "newsroom", "reports", "settings"].includes(tab) && (
          <div className="grid h-64 place-items-center rounded-xl border border-dashed border-border text-center">
            <div>
              <p className="font-display text-sm font-bold uppercase">{tab}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                This module remains outside Milestone 2.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function OrderTable({
  orders,
  onSelect,
}: {
  orders: Awaited<ReturnType<typeof listAdminOrdersFn>>;
  onSelect: (id: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Order</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Total</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => (
          <TableRow key={order.id} className="cursor-pointer" onClick={() => onSelect(order.id)}>
            <TableCell className="font-medium">{order.order_number}</TableCell>
            <TableCell>{order.customer_name ?? "Guest"}</TableCell>
            <TableCell>{rand(order.total_rand)}</TableCell>
            <TableCell>
              <Badge variant={statusVariant(order.status)}>{statusLabel(order.status)}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {new Date(order.created_at).toLocaleDateString("en-ZA")}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function OrdersPanel({
  orders,
  selected,
  onSelect,
  onTransition,
  onLoadMore,
}: {
  onLoadMore?: () => Promise<void>;
  orders: Awaited<ReturnType<typeof listAdminOrdersFn>>;
  selected: Awaited<ReturnType<typeof getAdminOrderFn>>;
  onSelect: (id: string) => void;
  onTransition: (id: string, status: AdminOrderStatus) => Promise<void>;
}) {
  const next = selected ? (transitions[selected.status as AdminOrderStatus] ?? []) : [];
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div>
        <h1 className="mb-4 font-display text-xl font-extrabold uppercase">Orders</h1>
        <OrderTable orders={orders} onSelect={onSelect} />
        {onLoadMore && (
          <Button variant="outline" size="sm" className="mt-4" onClick={() => void onLoadMore()}>
            Load older orders
          </Button>
        )}
      </div>
      {selected && (
        <aside className="rounded-xl border border-border bg-card p-5">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <p className="font-display text-lg font-bold">{selected.order_number}</p>
              <p className="text-xs text-muted-foreground">
                {selected.customer_name ?? "Customer"}
              </p>
            </div>
            <Badge variant={statusVariant(selected.status)}>{statusLabel(selected.status)}</Badge>
          </div>
          <div className="mb-5 space-y-2 text-xs">
            {selected.items.map((item) => (
              <div key={item.id} className="flex justify-between">
                <span>
                  {item.quantity} × {item.product_name}
                </span>
                <span>{rand(Number(item.unit_price_rand) * item.quantity)}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-border pt-4">
            <div className="mb-4 flex justify-between font-bold">
              <span>Total</span>
              <span>{rand(selected.total_rand)}</span>
            </div>
            <p className="mb-2 text-[0.65rem] font-bold uppercase text-muted-foreground">
              Next fulfilment steps
            </p>
            <div className="flex flex-wrap gap-2">
              {next.map((status) => (
                <Button
                  key={status}
                  size="sm"
                  variant="outline"
                  onClick={() => void onTransition(selected.id, status)}
                >
                  {statusLabel(status)}
                </Button>
              ))}
            </div>
            {!next.length && (
              <p className="text-xs text-muted-foreground">No further transitions.</p>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

function ProductsPanel({
  products,
  editingProduct,
  setEditingProduct,
  onSaved,
}: {
  products: Awaited<ReturnType<typeof listAdminProductsFn>>;
  editingProduct: string | null;
  setEditingProduct: (id: string | null) => void;
  onSaved: () => Promise<void>;
}) {
  const blank: AdminProductInput = {
    slug: "",
    name: "",
    category: "Flower",
    subcategory: null,
    description: null,
    price_rand: 0,
    unit: null,
    strain_type: null,
    badge: null,
    sort_order: 100,
    is_active: true,
  };
  const product = products.find((p) => p.id === editingProduct);
  const [form, setForm] = useState<AdminProductInput>(blank);
  useEffect(() => {
    setForm(
      product
        ? {
            slug: product.slug,
            name: product.name,
            category: product.category,
            subcategory: product.subcategory,
            description: product.description,
            price_rand: Number(product.price_rand),
            unit: product.unit,
            strain_type: product.strain_type,
            badge: product.badge,
            sort_order: product.sort_order,
            is_active: product.is_active,
          }
        : blank,
    );
    // Reset the form only when a different product is selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl font-extrabold uppercase">Products</h1>
          <p className="text-xs text-muted-foreground">
            Manager/admin operations. Prices retain historical versions.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditingProduct("new")}>
          <PlusCircle size={14} /> Add product
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {products.map((p) => (
            <TableRow key={p.id}>
              <TableCell>{p.name}</TableCell>
              <TableCell>{p.category}</TableCell>
              <TableCell>{rand(Number(p.price_rand))}</TableCell>
              <TableCell>
                <Badge variant={p.is_active ? "default" : "secondary"}>
                  {p.is_active ? "Active" : "Inactive"}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm" onClick={() => setEditingProduct(p.id)}>
                  Edit
                </Button>
                {p.is_active && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void deactivateAdminProductFn({ data: { productId: p.id } }).then(onSaved)
                    }
                  >
                    Deactivate
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {editingProduct && (
        <div className="mt-6 rounded-xl border border-border bg-card p-5">
          <h2 className="mb-4 font-display text-sm font-bold uppercase">
            {editingProduct === "new" ? "Add product" : "Edit product"}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Object.entries(form)
              .filter(([key]) => key !== "is_active")
              .map(([key, value]) => (
                <Input
                  key={key}
                  placeholder={key.replaceAll("_", " ")}
                  value={value == null ? "" : String(value)}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      [key]: ["price_rand", "sort_order"].includes(key)
                        ? Number(e.target.value)
                        : e.target.value,
                    }))
                  }
                />
              ))}
          </div>
          <div className="mt-4 flex gap-2">
            <Button
              onClick={() =>
                void saveAdminProductFn({
                  data: {
                    productId: editingProduct === "new" ? undefined : editingProduct,
                    input: form,
                  },
                }).then(async () => {
                  setEditingProduct(null);
                  await onSaved();
                })
              }
            >
              Save
            </Button>
            <Button variant="outline" onClick={() => setEditingProduct(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
