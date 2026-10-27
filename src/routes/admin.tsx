import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ROLE_LABEL, atLeast, canSee, type StaffRole } from "@/lib/admin-nav";
import {
  type LucideIcon,
  AlertTriangle,
  Bell,
  Boxes,
  Calendar,
  CircleUserRound,
  ClipboardList,
  Cog,
  CreditCard,
  History,
  LayoutDashboard,
  Megaphone,
  Newspaper,
  Package,
  PlusCircle,
  Search,
  ShieldCheck,
  ShoppingBag,
  Stethoscope,
  Store,
  Truck,
  Users,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ClinicalDocsPanel } from "@/components/admin/ClinicalDocsPanel";
import { IdChecksPanel } from "@/components/admin/IdChecksPanel";
import { PurchaseLimitsCard } from "@/components/admin/PurchaseLimitsCard";
import { AuditPanel } from "@/components/admin/AuditPanel";
import { PaymentsPanel } from "@/components/admin/PaymentsPanel";
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
  getMyStaffRoleFn,
  getMyStaffAccessFn,
  getAdminOrderFn,
  listAdminOrdersFn,
  listAdminProductsFn,
  listCustomersFn,
  listFulfilmentQueueFn,
  saveAdminProductFn,
  deactivateAdminProductFn,
  confirmOrderPaymentFn,
  transitionAdminOrderFn,
} from "@/lib/admin.functions";
import type { AdminOrder, AdminOrderStatus, AdminProductInput } from "@/lib/admin-data.server";
import { PosPanel } from "@/components/admin/pos/PosPanel";
import { ProductsPanel } from "@/components/admin/ProductsPanel";
import { InventoryPanel } from "@/components/admin/inventory/InventoryPanel";
import { LiveSales } from "@/components/admin/reports/LiveSales";
import { SalesReportsPanel } from "@/components/admin/reports/SalesReportsPanel";
import {
  notifyAdminTabs,
  sectionFromHash,
  useAdminTabSync,
  type AdminTopic,
} from "@/lib/admin-sync";
import { ReceiptSettingsPanel } from "@/components/admin/ReceiptSettingsPanel";
import logoImage from "@/assets/cannaplug-logo.png";
import { AdminSignIn, NoStaffAccess } from "@/components/admin/AdminSignIn";
import { AdminSearch, type SearchHit } from "@/components/admin/AdminSearch";
import { EmailCampaignsPanel } from "@/components/admin/EmailCampaignsPanel";
import { ReceiptActions } from "@/components/admin/receipts/ReceiptActions";
import type { SearchSale } from "@/lib/admin-search.server";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin Dashboard | CannaPlug" }] }),
  component: AdminPage,
});

const NAV_ITEMS: SidebarItem[] = [
  { id: "overview", icon: LayoutDashboard, label: "Overview" },
  { id: "pos", icon: Store, label: "POS" },
  { id: "orders", icon: ClipboardList, label: "Orders" },
  { id: "payments", icon: CreditCard, label: "Payments" },
  { id: "audit", icon: History, label: "Audit log" },
  { id: "products", icon: Package, label: "Products" },
  { id: "inventory", icon: Boxes, label: "Inventory" },
  { id: "customers", icon: Users, label: "Customers" },
  { id: "id-checks", icon: ShieldCheck, label: "ID Checks" },
  { id: "clinical", icon: Stethoscope, label: "Clinical Docs" },
  { id: "deliveries", icon: Truck, label: "Deliveries" },
  { id: "promotions", icon: Megaphone, label: "Email & promotions" },
  { id: "events", icon: Calendar, label: "Events" },
  { id: "newsroom", icon: Newspaper, label: "Newsroom" },
  { id: "reports", icon: Wallet, label: "Reports" },
  { id: "settings", icon: Cog, label: "Settings" },
];

/** Extra words the search box matches for each tab. */
const TAB_KEYWORDS: Record<string, string> = {
  pos: "till sale cash card receipt refund void drawer stock receive adjust",
  orders: "online order eft",
  payments: "payfast paypal eft bank exchange rate",
  "id-checks": "id verification document",
  settings: "receipt vat purchase limits",
  audit: "history log",
  deliveries: "driver delivery pickup collection",
  inventory: "stock available",
  promotions: "email campaign newsletter marketing subscribers",
};

const transitions: Record<AdminOrderStatus, AdminOrderStatus[]> = {
  awaiting_payment: ["cancelled"], // confirmation only comes from a verified payment
  confirmed: ["packing", "cancelled"],
  packing: ["ready"],
  ready: ["out_for_delivery"],
  out_for_delivery: ["completed"],
  completed: [],
  cancelled: [],
};
/** In-store pickup orders go ready -> completed (collected); the database enforces the same rule. */
const isPickup = (method: string | null | undefined) => method === "collection";
function nextStatuses(status: string, method: string | null | undefined): AdminOrderStatus[] {
  if (isPickup(method) && status === "ready") return ["completed"];
  return (transitions[status as AdminOrderStatus] ?? []).filter(
    (s) => !(status === "awaiting_payment" && s === "confirmed"),
  );
}
const statusLabel = (status: string) =>
  status.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
const statusVariant = (status: string) =>
  status === "completed" ? "default" : status === "cancelled" ? "destructive" : "secondary";

function AdminPage() {
  const { user, loading, signOut } = useAuth();
  // null = not checked yet; "none" = signed in but not staff
  const [access, setAccess] = useState<StaffRole | "none" | null>(null);
  const [tab, setTab] = useState("overview");
  const [role, setRole] = useState<StaffRole | null>(null);
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
  // Set by the search box: narrows Customers / Products to the chosen result until "Show all".
  const [focus, setFocus] = useState<{
    kind: "customer" | "product";
    id: string;
    label: string;
  } | null>(null);
  const [saleOpen, setSaleOpen] = useState<SearchSale | null>(null);
  // Each tab remembers its own section in the address (#pos), so a reload or a second tab opens where you were.
  useEffect(() => {
    const fromHash = sectionFromHash(window.location.hash, "");
    if (fromHash) setTab(fromHash);
    // Typing /admin#reports in the address bar, or Back / Forward, switches section too.
    const onHash = () => setTab(sectionFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const want = tab === "overview" ? "" : `#${tab}`;
    if (window.location.hash !== want)
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${want}`,
      );
  }, [tab]);
  const goTab = (next: string) => {
    setFocus(null);
    setTab(next);
  };
  const openHit = (hit: SearchHit) => {
    if (hit.kind === "tab") return goTab(hit.id);
    if (hit.kind === "order") {
      setFocus(null);
      setTab("orders");
      void getAdminOrderFn({ data: { orderId: hit.id } })
        .then(setSelectedOrder)
        .catch((e) => setError(e instanceof Error ? e.message : "Could not open the order."));
      return;
    }
    if (hit.kind === "sale") return setSaleOpen(hit.sale);
    setFocus({ kind: hit.kind, id: hit.id, label: hit.label });
    setTab(hit.kind === "customer" ? "customers" : "products");
  };

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
      const [r, d, o, p, c, f] = await Promise.all([
        getMyStaffRoleFn(),
        getAdminDashboardFn(),
        listAdminOrdersFn(),
        listAdminProductsFn(),
        listCustomersFn(),
        listFulfilmentQueueFn(),
      ]);
      setRole(r);
      if (!canSee(r, tab)) setTab("overview");
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
  // Changes made in another admin tab: reload quietly (no sign-in check, nothing on screen is reset).
  useAdminTabSync(["any"], () => {
    if (access && access !== "none") void refresh();
  });
  const refreshAndShare = async (topic: AdminTopic) => {
    await refresh();
    notifyAdminTabs(topic);
  };
  const userId = user?.id ?? null;
  useEffect(() => {
    setAccess(null);
    if (!userId) return;
    let alive = true;
    void getMyStaffAccessFn()
      .then(({ role: r }) => {
        if (!alive) return;
        setAccess(r ?? "none");
        if (r) void refresh();
      })
      .catch((e) => {
        if (!alive) return;
        setAccess("none");
        setError(e instanceof Error ? e.message : "Could not check your access.");
      });
    return () => {
      alive = false;
    };
    // Keyed on the signed-in person only: an hourly token refresh (in this tab or another) must not reload
    // the whole admin and wipe what is on screen. refresh() is re-created each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  if (loading || (user && access === null))
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <p className="text-sm text-muted-foreground" role="status">
          Loading admin dashboard…
        </p>
      </div>
    );
  if (!user) return <AdminSignIn />;
  if (access === "none")
    return <NoStaffAccess email={user.email ?? ""} onSignOut={() => void signOut()} />;

  return (
    <div className="site flex min-h-screen flex-col bg-background md:flex-row">
      <DashboardSidebar
        items={NAV_ITEMS.filter((i) => canSee(role, i.id))}
        active={tab}
        onSelect={goTab}
        hrefFor={(id) => (id === "overview" ? "/admin" : `/admin#${id}`)}
        header={
          <Link to="/">
            <img src={logoImage} alt="CannaPlug" className="h-6 w-auto" />
          </Link>
        }
      />
      <main className="flex-1 overflow-y-auto px-4 pb-24 pt-6 sm:px-8 sm:pt-8 md:pb-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <AdminSearch
            tabs={NAV_ITEMS.filter((i) => canSee(role, i.id)).map((i) => ({
              id: i.id,
              label: i.label,
              keywords: TAB_KEYWORDS[i.id],
            }))}
            onOpen={openHit}
          />
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
                <p className="font-semibold">{role ? ROLE_LABEL[role] : "Staff"}</p>
                <p className="text-muted-foreground">{user.email}</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => void signOut()}>
                Sign out
              </Button>
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
            <LiveSales />
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {(
                [
                  [
                    ShoppingBag,
                    "Total Orders",
                    dashboard.stats.totalOrders.toLocaleString("en-ZA"),
                  ],
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
              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="mb-4 font-display text-sm font-bold uppercase">
                  Top products online
                </h2>
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
              await refreshAndShare("orders");
            }}
            canConfirmPayment={atLeast(role, "manager")}
            onConfirmPayment={async (orderId, bankReference, amountReceived) => {
              const result = await confirmOrderPaymentFn({
                data: { orderId, bankReference, amountReceived },
              });
              await refreshAndShare("payments");
              return result;
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
              await refreshAndShare("orders");
            }}
            canConfirmPayment={atLeast(role, "manager")}
            onConfirmPayment={async (orderId, bankReference, amountReceived) => {
              const result = await confirmOrderPaymentFn({
                data: { orderId, bankReference, amountReceived },
              });
              await refreshAndShare("payments");
              return result;
            }}
          />
        )}
        {tab === "products" && (
          <>
            {focus?.kind === "product" && (
              <SearchFocus label={focus.label} onClear={() => setFocus(null)} />
            )}
            <ProductsPanel
              products={
                focus?.kind === "product" ? products.filter((p) => p.id === focus.id) : products
              }
              editingProduct={editingProduct}
              setEditingProduct={setEditingProduct}
              onSaved={() => refreshAndShare("products")}
              canEdit={atLeast(role, "manager")}
            />
          </>
        )}
        {tab === "inventory" && (
          <InventoryPanel
            canManage={atLeast(role, "manager")}
            onEditProduct={(id) => {
              setEditingProduct(id);
              setTab("products");
            }}
          />
        )}
        {tab === "payments" && <PaymentsPanel />}
        {tab === "audit" && <AuditPanel />}
        {tab === "id-checks" && <IdChecksPanel canResetAttempts={atLeast(role, "admin")} />}
        {tab === "clinical" && <ClinicalDocsPanel />}
        {tab === "customers" && (
          <div>
            <h1 className="mb-4 font-display text-xl font-extrabold uppercase">Customers</h1>
            {focus?.kind === "customer" && (
              <SearchFocus label={focus.label} onClear={() => setFocus(null)} />
            )}
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
                {(focus?.kind === "customer"
                  ? customers.filter((c) => c.id === focus.id)
                  : customers
                ).map((c) => (
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
        {tab === "settings" && (
          <>
            <ReceiptSettingsPanel />
            <PurchaseLimitsCard />
          </>
        )}
        <Dialog open={saleOpen !== null} onOpenChange={(o) => !o && setSaleOpen(null)}>
          <DialogContent>
            {saleOpen && (
              <>
                <DialogHeader>
                  <DialogTitle>{saleOpen.receipt_number}</DialogTitle>
                  <DialogDescription>
                    Till sale · {statusLabel(saleOpen.status)} · {rand(Number(saleOpen.total))} ·{" "}
                    {new Date(saleOpen.created_at).toLocaleString("en-ZA")}
                  </DialogDescription>
                </DialogHeader>
                <ReceiptActions saleId={saleOpen.id} />
                <p className="text-xs text-muted-foreground">
                  To void or refund, a manager opens POS and finds this receipt number.
                </p>
              </>
            )}
          </DialogContent>
        </Dialog>
        {tab === "promotions" && <EmailCampaignsPanel />}
        {tab === "reports" && <SalesReportsPanel canEmail={atLeast(role, "manager")} />}
        {["events", "newsroom"].includes(tab) && (
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
  onConfirmPayment,
  onLoadMore,
  canConfirmPayment = true,
}: {
  onLoadMore?: () => Promise<void>;
  /** Recording an EFT is a manager action (also enforced on the server). */
  canConfirmPayment?: boolean;
  onConfirmPayment: (
    id: string,
    bankReference: string,
    amountReceived: string,
  ) => Promise<{ outcome: string; duplicate: boolean }>;
  orders: Awaited<ReturnType<typeof listAdminOrdersFn>>;
  selected: Awaited<ReturnType<typeof getAdminOrderFn>>;
  onSelect: (id: string) => void;
  onTransition: (id: string, status: AdminOrderStatus) => Promise<void>;
}) {
  // The EFT form unmounts the moment the order is confirmed, so its outcome message lives here.
  const [paymentNote, setPaymentNote] = useState<{ orderId: string; text: string } | null>(null);
  // Unpaid orders are confirmed through the EFT receipt form below (records the bank reference and
  // checks the amount), not by a bare status change.
  const next = selected ? nextStatuses(selected.status, selected.delivery_method) : [];
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
          {paymentNote && paymentNote.orderId === selected.id && (
            <p
              role="status"
              className="mb-4 rounded-md bg-primary/10 px-3 py-2 text-xs font-medium"
            >
              {paymentNote.text}
            </p>
          )}
          <OrderDelivery order={selected} />
          <div className="border-t border-border pt-4">
            {Number(selected.delivery_fee_rand) > 0 && (
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>Delivery</span>
                <span>{rand(Number(selected.delivery_fee_rand))}</span>
              </div>
            )}
            {Number(selected.loyalty_discount_rand) > 0 && (
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>Points discount ({selected.loyalty_points_redeemed} pts)</span>
                <span>-{rand(Number(selected.loyalty_discount_rand))}</span>
              </div>
            )}
            <div className="mb-4 flex justify-between font-bold">
              <span>Total</span>
              <span>{rand(selected.total_rand)}</span>
            </div>
            {canConfirmPayment && selected.status === "awaiting_payment" && (
              <EftConfirm
                order={selected}
                onConfirm={onConfirmPayment}
                onResult={(text) => setPaymentNote(text ? { orderId: selected.id, text } : null)}
              />
            )}
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

type AddressSnapshot = {
  label?: string | null;
  recipient_name?: string | null;
  phone?: string | null;
  line1?: string | null;
  line2?: string | null;
  suburb?: string | null;
  city?: string | null;
  province?: string | null;
  postal_code?: string | null;
  delivery_notes?: string | null;
};

function SearchFocus({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-[#D4AF37]/50 bg-[#D4AF37]/10 px-3 py-2 text-xs">
      <span>
        Showing search result: <b>{label}</b>
      </span>
      <button type="button" className="font-semibold text-primary" onClick={onClear}>
        Show all
      </button>
    </div>
  );
}

function OrderDelivery({
  order,
}: {
  order: NonNullable<Awaited<ReturnType<typeof getAdminOrderFn>>>;
}) {
  const address = (order.delivery_address ?? null) as AddressSnapshot | null;
  const lines = address
    ? [
        address.line1,
        address.line2,
        address.suburb,
        address.city,
        address.province,
        address.postal_code,
      ]
        .filter(Boolean)
        .join(", ")
    : null;
  return (
    <div className="mb-5 space-y-1 rounded-lg border border-border p-3 text-xs">
      <p className="text-[0.65rem] font-bold uppercase text-muted-foreground">
        {isPickup(order.delivery_method) ? "In-store pickup & contact" : "Delivery & contact"}
      </p>
      {isPickup(order.delivery_method) && (
        <p className="rounded bg-[#D4AF37]/15 px-2 py-1 font-semibold text-[#0B3D20]">
          Customer collects at the shop. Check 18+ ID on collection, then mark Completed.
        </p>
      )}
      <p>
        {order.contact_name ?? order.customer_name ?? "—"}
        {order.contact_phone ? ` · ${order.contact_phone}` : ""}
      </p>
      {order.customer_email && <p className="text-muted-foreground">{order.customer_email}</p>}
      {lines ? (
        <p>
          {address?.recipient_name ? `${address.recipient_name}, ` : ""}
          {lines}
        </p>
      ) : (
        <p className="text-muted-foreground">No delivery address on this order.</p>
      )}
      {address?.delivery_notes && <p className="italic">Notes: {address.delivery_notes}</p>}
      {order.notes && <p className="italic">Customer note: {order.notes}</p>}
      <p className="text-muted-foreground">
        {isPickup(order.delivery_method)
          ? "In-store pickup"
          : order.delivery_method
            ? `${statusLabel(order.delivery_method)} delivery`
            : "No delivery method"}
        {order.payment_method ? ` · Pay by ${order.payment_method.toUpperCase()}` : ""}
      </p>
      {order.prescription && <PrescriptionLine rx={order.prescription} />}
    </div>
  );
}

/** Only the number, validity and a verify link — never clinical text, quantities or practitioner notes. */
function PrescriptionLine({ rx }: { rx: NonNullable<AdminOrder["prescription"]> }) {
  const until = rx.valid_until
    ? new Date(rx.valid_until).toLocaleDateString("en-ZA", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
  return (
    <p className={rx.valid ? "text-primary" : "font-semibold text-destructive"}>
      {rx.valid
        ? `Covered by prescription ${rx.document_number}, valid until ${until}`
        : `Check before packing: prescription ${rx.document_number} is no longer valid${rx.link_status === "flagged" ? " (revoked)" : ""}`}{" "}
      ·{" "}
      <a href={`/verify/${rx.verify_token}`} target="_blank" rel="noreferrer" className="underline">
        Verify
      </a>
    </p>
  );
}

const EFT_MESSAGES: Record<string, string> = {
  confirmed: "Payment recorded — the order is confirmed and stock has been taken.",
  pending_approval:
    "Recorded. This amount needs a SECOND manager to approve it (Payments tab) before the order is confirmed.",
  order_total_changed:
    "The order total changed after this payment was recorded. Nothing was changed.",
  amount_mismatch: "The amount received does not match the order total. Nothing was changed.",
  already_processed: "This order has already been processed.",
  paid_after_cancel_needs_refund: "This order was cancelled — the payment needs a refund.",
  stock_unavailable_needs_refund:
    "The hold expired and stock is no longer available — refund the customer.",
  order_not_found: "Order not found.",
};

function EftConfirm({
  order,
  onConfirm,
  onResult,
}: {
  order: NonNullable<Awaited<ReturnType<typeof getAdminOrderFn>>>;
  /** Reports the outcome to the parent: this form unmounts as soon as the order leaves awaiting_payment. */
  onResult: (text: string | null) => void;
  onConfirm: (
    id: string,
    bankReference: string,
    amountReceived: string,
  ) => Promise<{ outcome: string; duplicate: boolean }>;
}) {
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState(String(order.total_rand));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setReference("");
    setAmount(String(order.total_rand));
  }, [order.id, order.total_rand]);
  const valid = reference.trim().length >= 4 && /^[0-9]{1,8}(\.[0-9]{1,2})?$/.test(amount);
  return (
    <div className="mb-4 rounded-lg border border-dashed border-border p-3">
      <p className="mb-2 text-[0.65rem] font-bold uppercase text-muted-foreground">
        Confirm EFT received (manager)
      </p>
      <p className="mb-2 text-[0.65rem] text-muted-foreground">
        Customer reference: <b>{order.order_number}</b>. Enter the bank reference and the amount
        that cleared. Each bank reference can be used once.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="Bank reference"
          placeholder="Bank reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <Input
          aria-label="Amount received"
          className="w-28"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <Button
        size="sm"
        className="mt-2"
        disabled={!valid || busy}
        onClick={async () => {
          setBusy(true);
          onResult(null);
          try {
            const result = await onConfirm(order.id, reference.trim(), amount);
            onResult(
              result.duplicate
                ? "That bank reference was already recorded."
                : (EFT_MESSAGES[result.outcome] ?? result.outcome),
            );
          } catch (err) {
            onResult(err instanceof Error ? err.message : "Could not record the payment.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Recording…" : "Confirm payment"}
      </Button>
    </div>
  );
}
