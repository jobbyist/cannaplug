import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ROLE_LABEL, atLeast, canSee, type StaffRole } from "@/lib/admin-nav";
import {
  type LucideIcon,
  AlertTriangle,
  Boxes,
  Calendar,
  CircleUserRound,
  ClipboardList,
  Cog,
  CreditCard,
  History,
  LayoutDashboard,
  Megaphone,
  FlaskConical,
  Newspaper,
  Package,
  PlusCircle,
  Receipt,
  Search,
  ShieldCheck,
  ShoppingBag,
  Stethoscope,
  Store,
  Truck,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BillingPanel } from "@/components/admin/BillingPanel";
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
import { DemoTill } from "@/components/admin/pos/DemoTill";
import { ProductsPanel } from "@/components/admin/ProductsPanel";
import { ProductEditDialog } from "@/components/admin/ProductEditDialog";
import { InventoryPanel } from "@/components/admin/inventory/InventoryPanel";
import { CustomersPanel } from "@/components/admin/CustomersPanel";
import { OrdersPanel } from "@/components/admin/orders/OrdersPanel";
import { statusLabel } from "@/components/admin/orders/orders-logic";
import { OverviewPanel } from "@/components/admin/overview/OverviewPanel";
import { SearchFocus } from "@/components/admin/SearchFocus";
import { useAttentionCounts } from "@/hooks/useAttentionCounts";
import { useStaffRoleSync } from "@/hooks/useStaffRoleSync";
import { setOrderArchivedFn } from "@/lib/admin.functions";
import { NewsroomPanel } from "@/components/admin/NewsroomPanel";
import { NotificationsBell } from "@/components/admin/NotificationsBell";
import { NotificationsPanel } from "@/components/admin/NotificationsPanel";
import { StaffPanel } from "@/components/admin/StaffPanel";
import { useTeamNotifications } from "@/hooks/useTeamNotifications";
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
import { Breadcrumbs } from "@/components/Breadcrumbs";
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
  { id: "demo-till", icon: FlaskConical, label: "Demo till" },
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
  { id: "staff", icon: UserCog, label: "Staff" },
  { id: "notifications", icon: Megaphone, label: "Notifications" },
  { id: "billing", icon: Receipt, label: "Billing" },
  { id: "settings", icon: Cog, label: "Settings" },
];

/** Extra words the search box matches for each tab. */
const TAB_KEYWORDS: Record<string, string> = {
  pos: "till sale cash card receipt refund void drawer stock receive adjust",
  "demo-till": "demo test practice training sandbox till",
  orders: "online order eft",
  payments: "payfast paypal eft bank exchange rate",
  "id-checks": "id verification document",
  settings: "receipt vat purchase limits",
  audit: "history log",
  deliveries: "driver delivery pickup collection",
  inventory: "stock available",
  promotions: "email campaign newsletter marketing subscribers",
  staff: "roles team budtender manager admin permissions access",
  billing:
    "invoice subscription recurring payfast paypal shopify verifynow whatsapp pay pause cancel services",
  notifications: "bell updates messages announcements reminders team",
};

function AdminPage() {
  const { user, loading, signOut } = useAuth();
  // null = not checked yet; "none" = signed in but not staff
  const [access, setAccess] = useState<StaffRole | "none" | null>(null);
  const [tab, setTab] = useState("overview");
  const [role, setRole] = useState<StaffRole | null>(null);
  // Live team notices for the bell and the Notifications tab; only staff subscribe.
  const team = useTeamNotifications(role ? user?.id : undefined);
  // Sidebar badges: what needs a person right now. The notices changing is a hint that something moved.
  const attention = useAttentionCounts(!!role, `${team.fresh}:${team.unread}`);
  const [dashboard, setDashboard] = useState<Awaited<
    ReturnType<typeof getAdminDashboardFn>
  > | null>(null);
  const [orders, setOrders] = useState<Awaited<ReturnType<typeof listAdminOrdersFn>>>([]);
  const [products, setProducts] = useState<Awaited<ReturnType<typeof listAdminProductsFn>>>([]);
  const [showArchived, setShowArchived] = useState(false);
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
  // Follow role changes made elsewhere (promoted, demoted, removed) without a reload.
  useStaffRoleSync({
    enabled: !!role,
    role,
    onChange: (next) => {
      setRole(next);
      if (!next) setAccess("none");
      else if (!canSee(next, tab)) setTab("overview");
    },
  });
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
      const older = await listAdminOrdersFn({
        data: { before: last.created_at, includeArchived: showArchived },
      });
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
      const [r, d, o, p, f] = await Promise.all([
        getMyStaffRoleFn(),
        getAdminDashboardFn(),
        listAdminOrdersFn({ data: { includeArchived: showArchived } }),
        listAdminProductsFn(),
        listFulfilmentQueueFn(),
      ]);
      setRole(r);
      if (!canSee(r, tab)) setTab("overview");
      setDashboard(d);
      setOrders(o);
      setHasMoreOrders(o.length >= 100);
      setProducts(p);
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
  const archiveOrder = async (orderId: string, archived: boolean, reason: string) => {
    await setOrderArchivedFn({ data: { orderId, archived, reason, key: crypto.randomUUID() } });
    await refresh();
    notifyAdminTabs("orders");
  };
  const toggleArchived = (show: boolean) => {
    setShowArchived(show);
    void listAdminOrdersFn({ data: { includeArchived: show } })
      .then((o) => {
        setOrders(o);
        setHasMoreOrders(o.length >= 100);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load orders."));
  };
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

  const badges: Record<string, number> = {
    orders: attention.counts.orders_to_pack,
    "id-checks": attention.counts.id_checks,
    inventory: attention.counts.low_stock,
    ...(atLeast(role, "manager")
      ? { pos: attention.counts.variances, payments: attention.counts.eft_waiting }
      : {}),
  };
  const navItems: SidebarItem[] = NAV_ITEMS.filter((i) => canSee(role, i.id)).map((i) => ({
    ...i,
    badge: badges[i.id],
  }));

  return (
    <div className="site flex min-h-screen flex-col bg-background md:flex-row">
      <DashboardSidebar
        items={navItems}
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
        <Breadcrumbs
          bare
          trail={[
            { label: "Home", to: "/" },
            { label: "Admin" },
            ...(navItems.find((i) => i.id === tab)
              ? [{ label: navItems.find((i) => i.id === tab)!.label }]
              : []),
          ]}
        />
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <AdminSearch
            tabs={navItems.map((i) => ({
              id: i.id,
              label: i.label,
              keywords: TAB_KEYWORDS[i.id],
            }))}
            onOpen={openHit}
          />
          <div className="flex items-center gap-3">
            <NotificationsBell
              team={team}
              onManage={atLeast(role, "manager") ? () => goTab("notifications") : undefined}
            />
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
          <OverviewPanel
            dashboard={dashboard}
            canSeeMoney={atLeast(role, "manager")}
            onViewOrders={() => setTab("orders")}
            onSelectOrder={(id) => {
              void getAdminOrderFn({ data: { orderId: id } }).then(setSelectedOrder);
              setTab("orders");
            }}
          />
        )}

        {tab === "pos" && <PosPanel />}
        {tab === "demo-till" && atLeast(role, "manager") && <DemoTill />}
        {tab === "orders" && (
          <OrdersPanel
            orders={orders}
            {...(atLeast(role, "manager")
              ? {
                  onArchive: archiveOrder,
                  showArchived,
                  onToggleArchived: toggleArchived,
                }
              : {})}
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
          <>
            <InventoryPanel
              canManage={atLeast(role, "manager")}
              onEditProduct={(id) => setEditingProduct(id)}
            />
            {atLeast(role, "manager") && (
              <ProductEditDialog
                products={products}
                editingProduct={editingProduct}
                setEditingProduct={setEditingProduct}
                onSaved={() => refreshAndShare("products")}
              />
            )}
          </>
        )}
        {tab === "payments" && <PaymentsPanel />}
        {tab === "audit" && <AuditPanel />}
        {tab === "id-checks" && <IdChecksPanel canResetAttempts={atLeast(role, "admin")} />}
        {tab === "clinical" && <ClinicalDocsPanel />}
        {tab === "customers" && (
          <CustomersPanel
            focusLabel={focus?.kind === "customer" ? focus.label : null}
            onClearFocus={() => setFocus(null)}
            canEditUsername={atLeast(role, "manager")}
          />
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
        {tab === "newsroom" && atLeast(role, "manager") && <NewsroomPanel />}
        {tab === "staff" && atLeast(role, "manager") && <StaffPanel role={role} myId={user.id} />}
        {tab === "billing" && atLeast(role, "manager") && <BillingPanel role={role} />}
        {tab === "notifications" && atLeast(role, "manager") && (
          <NotificationsPanel team={team} role={role} />
        )}
        {(tab === "events" || (tab === "newsroom" && !atLeast(role, "manager"))) && (
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
