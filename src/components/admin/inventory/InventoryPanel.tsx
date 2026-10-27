import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  Download,
  History,
  MoreHorizontal,
  PackageOpen,
  PackagePlus,
  Pencil,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { rand } from "@/lib/cart";
import {
  DEFAULT_FILTERS,
  STATUS_LABEL,
  categoriesOf,
  expiresSoon,
  filterInventory,
  inventoryCsv,
  stockStatus,
  summarise,
  type InventoryFilters,
  type InventoryRow,
  type SortKey,
  type StatusFilter,
  type StockStatus,
} from "@/lib/inventory-logic";
import { notifyAdminTabs, useAdminTabSync } from "@/lib/admin-sync";
import { AdjustDialog, HistoryDialog, ReceiveDialog, ThresholdDialog } from "./InventoryDialogs";
import { serverInventoryApi, type InventoryApi } from "./inventory-api";

const PAGE = 50;
const ALL = "__all__";

const STATUS_STYLE: Record<StockStatus, string> = {
  out: "border-destructive/30 bg-destructive/10 text-destructive",
  low: "border-amber-500/30 bg-amber-500/10 text-amber-700",
  ok: "border-primary/30 bg-primary/10 text-primary",
  untracked: "border-border bg-muted text-muted-foreground",
};

type DialogState =
  | { kind: "receive"; row: InventoryRow | null }
  | { kind: "adjust" | "history" | "threshold"; row: InventoryRow }
  | null;

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "2-digit" });

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  active,
  onClick,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: typeof AlertTriangle;
  tone?: "default" | "danger" | "warn";
  active?: boolean;
  onClick?: () => void;
}) {
  const toneCls =
    tone === "danger" ? "text-destructive" : tone === "warn" ? "text-amber-600" : "text-primary";
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">
        <Icon size={13} className={toneCls} /> {label}
      </span>
      <span className={`mt-1 block font-display text-2xl font-extrabold ${toneCls}`}>{value}</span>
      {hint && <span className="block text-[0.68rem] text-muted-foreground">{hint}</span>}
    </>
  );
  const cls = `rounded-xl border bg-card p-3 text-left transition ${active ? "border-primary ring-2 ring-primary/30" : "border-border"}`;
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!!active}
      className={`${cls} hover:border-primary/60`}
    >
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Level bar: full at three times the low-stock alert level. */
function LevelBar({ row }: { row: InventoryRow }) {
  const status = stockStatus(row);
  const target = Math.max(row.low_stock_threshold * 3, 10);
  const pct = Math.max(0, Math.min(100, (row.available / target) * 100));
  const color =
    status === "out" ? "bg-destructive" : status === "low" ? "bg-amber-500" : "bg-primary";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * /admin → Inventory: every product's stock at a glance, with search, filters and one-click actions.
 * Receiving and adjusting open a modal; budtenders can look but not change anything (the server refuses too).
 */
export function InventoryPanel({
  canManage,
  onEditProduct,
  api = serverInventoryApi,
}: {
  canManage: boolean;
  onEditProduct?: (productId: string) => void;
  api?: InventoryApi;
}) {
  const [rows, setRows] = useState<InventoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<InventoryFilters>(DEFAULT_FILTERS);
  const [limit, setLimit] = useState(PAGE);
  const [dialog, setDialog] = useState<DialogState>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.list());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load inventory.");
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => setLimit(PAGE), [filters]);

  const all = useMemo(() => rows ?? [], [rows]);
  const summary = useMemo(() => summarise(all), [all]);
  const categories = useMemo(() => categoriesOf(all), [all]);
  const visible = useMemo(() => filterInventory(all, filters), [all, filters]);
  const set = <K extends keyof InventoryFilters>(k: K, v: InventoryFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));
  const toggleStatus = (s: StatusFilter) =>
    setFilters((f) => ({ ...f, status: f.status === s ? "all" : s }));
  const filtered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);

  const done = async (message: string) => {
    setNotice(message);
    await load();
    notifyAdminTabs("stock");
  };
  // A sale, refund or stock change in another admin tab: reload quietly, keeping filters and search.
  useAdminTabSync(["stock", "products"], () => void load());
  const downloadCsv = () => {
    const blob = new Blob([inventoryCsv(visible)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cannaplug-stock-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const close = (o: boolean) => !o && setDialog(null);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-extrabold uppercase">Inventory</h1>
          <p className="text-sm text-muted-foreground">
            Available = on hand minus stock held for unpaid online orders.
            {canManage ? " Use Receive and Adjust on any row." : " Managers can change stock."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={downloadCsv} disabled={!visible.length}>
            <Download size={14} /> Stock sheet
          </Button>
          {canManage && (
            <Button size="sm" onClick={() => setDialog({ kind: "receive", row: null })}>
              <PackagePlus size={14} /> Receive delivery
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Products"
          value={summary.products}
          hint={`${summary.units} on hand · ${summary.held} held`}
          icon={PackageOpen}
          active={filters.status === "all" && !filtered}
          onClick={() => setFilters(DEFAULT_FILTERS)}
        />
        <StatCard
          label="Low stock"
          value={summary.low}
          icon={AlertTriangle}
          tone="warn"
          active={filters.status === "low"}
          onClick={() => toggleStatus("low")}
        />
        <StatCard
          label="Out of stock"
          value={summary.out}
          icon={X}
          tone="danger"
          active={filters.status === "out"}
          onClick={() => toggleStatus("out")}
        />
        <StatCard
          label="Expiring ≤30 days"
          value={summary.expiring}
          icon={CalendarClock}
          tone="warn"
          active={filters.status === "expiring"}
          onClick={() => toggleStatus("expiring")}
        />
        <StatCard
          label="Expired stock"
          value={summary.expired}
          hint="Not sellable; adjust out"
          icon={CalendarClock}
          tone="danger"
          active={filters.status === "expired"}
          onClick={() => toggleStatus("expired")}
        />
        {summary.value != null ? (
          <StatCard
            label="Stock at cost"
            value={rand(Math.round(summary.value))}
            icon={PackageOpen}
          />
        ) : (
          <StatCard label="Categories" value={categories.length} icon={PackageOpen} />
        )}
      </div>

      <div className="grid gap-2 rounded-xl border border-border bg-card p-3 md:grid-cols-[1fr_auto_auto_auto_auto] md:items-end">
        <div className="relative">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search inventory"
            placeholder="Search name, SKU or brand…"
            className="pl-9"
            value={filters.q}
            onChange={(e) => set("q", e.target.value)}
          />
        </div>
        <Select
          value={filters.category || ALL}
          onValueChange={(v) => set("category", v === ALL ? "" : v)}
        >
          <SelectTrigger aria-label="Category" className="md:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.status} onValueChange={(v) => set("status", v as StatusFilter)}>
          <SelectTrigger aria-label="Stock status" className="md:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            <SelectItem value="out">Out of stock</SelectItem>
            <SelectItem value="low">Low stock</SelectItem>
            <SelectItem value="ok">In stock</SelectItem>
            <SelectItem value="expiring">Expiring ≤30 days</SelectItem>
            <SelectItem value="expired">Has expired stock</SelectItem>
            <SelectItem value="untracked">Not tracked</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.sort} onValueChange={(v) => set("sort", v as SortKey)}>
          <SelectTrigger aria-label="Sort" className="md:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="attention">Needs attention first</SelectItem>
            <SelectItem value="name">Name A–Z</SelectItem>
            <SelectItem value="available_asc">Least available</SelectItem>
            <SelectItem value="available_desc">Most available</SelectItem>
            <SelectItem value="category">Category</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 px-1 md:h-10">
          <Switch
            id="inv-inactive"
            checked={filters.showInactive}
            onCheckedChange={(v) => set("showInactive", v)}
          />
          <Label htmlFor="inv-inactive" className="text-xs">
            Show inactive
          </Label>
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-xs text-primary"
        >
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {rows ? `${visible.length} of ${all.length} products` : "Loading…"}
          {filtered && (
            <button
              type="button"
              className="ml-2 font-semibold text-primary underline"
              onClick={() => setFilters(DEFAULT_FILTERS)}
            >
              Clear filters
            </button>
          )}
        </span>
      </div>

      <ul className="grid gap-2" aria-label="Inventory">
        {visible.slice(0, limit).map((r) => {
          const status = stockStatus(r);
          return (
            <li
              key={r.product_id}
              className="grid gap-3 rounded-xl border border-border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-center"
            >
              <div className="flex min-w-0 items-center gap-3">
                {r.image_url ? (
                  <img
                    src={r.image_url}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <PackageOpen size={16} className="text-muted-foreground" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{r.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[r.sku, r.category, r.brand].filter(Boolean).join(" · ")}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge variant="outline" className={STATUS_STYLE[status]}>
                      {STATUS_LABEL[status]}
                    </Badge>
                    {!r.is_active && <Badge variant="outline">Inactive</Badge>}
                    {!r.sell_online && <Badge variant="outline">In store only</Badge>}
                    {r.regular_price_rand != null && (
                      <Badge
                        variant="outline"
                        className="border-[#D4AF37]/60 bg-[#D4AF37]/15 text-[#0B3D20]"
                      >
                        Sale {rand(r.price_rand)}
                      </Badge>
                    )}
                    {r.expired > 0 && (
                      <Badge variant="outline" className={STATUS_STYLE.out}>
                        {r.expired} expired
                      </Badge>
                    )}
                    {expiresSoon(r) && r.next_expiry && (
                      <Badge variant="outline" className={STATUS_STYLE.low}>
                        Expires {shortDate(r.next_expiry)}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
              <div className="grid gap-1">
                <p className="text-sm">
                  <span className="font-display text-lg font-extrabold">{r.available}</span>{" "}
                  <span className="text-xs text-muted-foreground">available</span>
                </p>
                {r.track_stock && <LevelBar row={r} />}
                <p className="text-[0.68rem] text-muted-foreground">
                  {r.on_hand} on hand · {r.held} held · alert at {r.low_stock_threshold}
                </p>
              </div>
              <div className="flex items-center gap-1.5 sm:justify-end">
                {canManage && r.track_stock && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Receive stock for ${r.name}`}
                      onClick={() => setDialog({ kind: "receive", row: r })}
                    >
                      <PackagePlus size={14} /> Receive
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Adjust stock for ${r.name}`}
                      onClick={() => setDialog({ kind: "adjust", row: r })}
                    >
                      <SlidersHorizontal size={14} /> Adjust
                    </Button>
                  </>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" aria-label={`More actions for ${r.name}`}>
                      <MoreHorizontal size={16} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setDialog({ kind: "history", row: r })}>
                      <History size={14} /> Stock history
                    </DropdownMenuItem>
                    {canManage && (
                      <DropdownMenuItem onSelect={() => setDialog({ kind: "threshold", row: r })}>
                        <Bell size={14} /> Low-stock alert…
                      </DropdownMenuItem>
                    )}
                    {onEditProduct && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => onEditProduct(r.product_id)}>
                          <Pencil size={14} /> {canManage ? "Edit product & price" : "View product"}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          );
        })}
      </ul>
      {rows && visible.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No products match. {filtered && "Try clearing the filters."}
        </p>
      )}
      {visible.length > limit && (
        <div className="text-center">
          <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
            Show {Math.min(PAGE, visible.length - limit)} more
          </Button>
        </div>
      )}

      <ReceiveDialog
        open={dialog?.kind === "receive"}
        onOpenChange={close}
        row={dialog?.kind === "receive" ? dialog.row : null}
        rows={all}
        api={api}
        onDone={done}
      />
      <AdjustDialog
        open={dialog?.kind === "adjust"}
        onOpenChange={close}
        row={dialog?.kind === "adjust" ? dialog.row : null}
        api={api}
        onDone={done}
        onReceiveInstead={() =>
          dialog && dialog.kind === "adjust" && setDialog({ kind: "receive", row: dialog.row })
        }
      />
      <HistoryDialog
        open={dialog?.kind === "history"}
        onOpenChange={close}
        row={dialog?.kind === "history" ? dialog.row : null}
        api={api}
      />
      <ThresholdDialog
        open={dialog?.kind === "threshold"}
        onOpenChange={close}
        row={dialog?.kind === "threshold" ? dialog.row : null}
        api={api}
        onDone={done}
      />
    </div>
  );
}
