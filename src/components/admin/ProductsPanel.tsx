import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PackageOpen,
  PlusCircle,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  deleteAdminProductFn,
  listAdminProductsFn,
  restoreAdminProductFn,
  setAdminProductsActiveFn,
} from "@/lib/admin.functions";
import { serverInventoryApi } from "@/components/admin/inventory/inventory-api";
import type { InventoryRow } from "@/lib/inventory-logic";
import {
  DEFAULT_PRODUCT_FILTERS,
  filterProducts,
  outOfStockIds,
  productCategories,
  productSubcategories,
  type ProductFilters,
  type ProductStatusFilter,
} from "@/lib/product-filters";
import { useAdminTabSync } from "@/lib/admin-sync";
import { CatalogueImport } from "@/components/admin/CatalogueImport";
import { ProductEditDialog } from "@/components/admin/ProductEditDialog";
import { ProductCsv } from "@/components/admin/ProductCsv";

type AdminProduct = Awaited<ReturnType<typeof listAdminProductsFn>>[number];

/** Set once the product-delete migration is applied; older databases simply have no archived products. */
const isArchived = (p: AdminProduct) => Boolean((p as { archived_at?: string | null }).archived_at);
const PAGE = 50;
const ALL = "__all__";
const errorText = (e: unknown) =>
  e instanceof Error && e.message ? e.message : "That didn't work and nothing was changed.";

export function ProductsPanel({
  products,
  editingProduct,
  setEditingProduct,
  onSaved,
  canEdit = true,
  loadStock = serverInventoryApi.list,
}: {
  products: AdminProduct[];
  editingProduct: string | null;
  setEditingProduct: (id: string | null) => void;
  onSaved: () => Promise<void>;
  /** Budtenders see the list only; every change is also refused on the server. */
  canEdit?: boolean;
  /** Stock levels for the "Out of stock" filter (the Inventory list). Injected so tests need no server. */
  loadStock?: () => Promise<InventoryRow[]>;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [deleting, setDeleting] = useState<AdminProduct | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [filters, setFilters] = useState<ProductFilters>(DEFAULT_PRODUCT_FILTERS);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stock, setStock] = useState<InventoryRow[] | null>(null);
  const [stockFailed, setStockFailed] = useState(false);

  const refreshStock = useCallback(async () => {
    try {
      setStock(await loadStock());
      setStockFailed(false);
    } catch {
      setStockFailed(true);
    }
  }, [loadStock]);
  useEffect(() => {
    void refreshStock();
  }, [refreshStock]);
  // A sale or stock change in another admin tab: refresh quietly, keeping filters and ticks.
  useAdminTabSync(["stock"], () => void refreshStock());

  const archivedCount = useMemo(() => products.filter(isArchived).length, [products]);
  const pool = useMemo(
    () => (showArchived ? products : products.filter((p) => !isArchived(p))),
    [products, showArchived],
  );
  const outIds = useMemo(() => outOfStockIds(stock), [stock]);
  const outCount = useMemo(
    () => pool.filter((p) => !isArchived(p) && outIds.has(p.id)).length,
    [pool, outIds],
  );
  const categories = useMemo(() => productCategories(pool), [pool]);
  const subcategories = useMemo(
    () => productSubcategories(pool, filters.category),
    [pool, filters.category],
  );
  const shown = useMemo(() => filterProducts(pool, filters, outIds), [pool, filters, outIds]);
  const filtered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_PRODUCT_FILTERS);
  const activeCount = useMemo(
    () => pool.filter((p) => !isArchived(p) && p.is_active).length,
    [pool],
  );

  const set = <K extends keyof ProductFilters>(k: K, v: ProductFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));
  // Changing what is on screen clears the ticks, so a bulk action never reaches a product you can't see.
  useEffect(() => {
    setLimit(PAGE);
    setSelected(new Set());
  }, [filters, showArchived]);

  // Archived products can only be restored, never ticked.
  const selectable = useMemo(() => shown.filter((p) => !isArchived(p)), [shown]);
  const selectedProducts = useMemo(
    () => selectable.filter((p) => selected.has(p.id)),
    [selectable, selected],
  );
  const allTicked = selectable.length > 0 && selectedProducts.length === selectable.length;
  const toggleOne = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allTicked ? new Set() : new Set(selectable.map((p) => p.id)));

  const bulkSetActive = async (active: boolean) => {
    const ids = selectedProducts.filter((p) => p.is_active !== active).map((p) => p.id);
    if (ids.length === 0) {
      setNotice({ text: `Everything ticked is already ${active ? "active" : "inactive"}.` });
      return;
    }
    setBusy(true);
    try {
      const r = await setAdminProductsActiveFn({ data: { productIds: ids, active } });
      setNotice({
        text: `${r.changed.length} product${r.changed.length === 1 ? "" : "s"} made ${active ? "active" : "inactive"}.${
          r.skipped ? ` ${r.skipped} skipped (archived or not found).` : ""
        }`,
      });
      setSelected(new Set());
      await onSaved();
    } catch (e) {
      setNotice({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      const r = await deleteAdminProductFn({
        data: { productId: deleting.id, key: crypto.randomUUID() },
      });
      setNotice({
        text:
          r.mode === "deleted"
            ? `${r.name} was deleted.`
            : `${r.name} has sales or stock history, so it was archived instead: it is switched off and hidden from the lists, and its past sales and receipts are kept. Use "Show archived" to restore it.`,
      });
      setDeleting(null);
      await onSaved();
    } catch (e) {
      setNotice({ text: errorText(e), error: true });
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  };
  const restore = async (p: AdminProduct) => {
    try {
      await restoreAdminProductFn({ data: { productId: p.id, key: crypto.randomUUID() } });
      setNotice({ text: `${p.name} was restored and is active again.` });
      await onSaved();
    } catch (e) {
      setNotice({ text: errorText(e), error: true });
    }
  };
  const toggleActive = async (p: AdminProduct) => {
    try {
      await setAdminProductsActiveFn({ data: { productIds: [p.id], active: !p.is_active } });
      await onSaved();
    } catch (e) {
      setNotice({ text: errorText(e), error: true });
    }
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-extrabold uppercase">Products</h1>
          <p className="text-sm text-muted-foreground">
            Managers and admins edit products. Prices keep their history; cost prices are visible to
            managers only.
            {canEdit && " Tick products to switch several on or off at once."}
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <ProductCsv onSaved={onSaved} />
            <CatalogueImport onImported={onSaved} />
            <Button size="sm" onClick={() => setEditingProduct("new")}>
              <PlusCircle size={14} /> Add product
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <button
          type="button"
          aria-pressed={filters.status === "all" && !filters.outOfStock}
          onClick={() => setFilters((f) => ({ ...f, status: "all", outOfStock: false }))}
          className={`rounded-xl border bg-card p-3 text-left transition hover:border-primary/60 ${filters.status === "all" && !filters.outOfStock ? "border-primary ring-2 ring-primary/30" : "border-border"}`}
        >
          <span className="flex items-center gap-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">
            <PackageOpen size={13} className="text-primary" /> Products
          </span>
          <span className="mt-1 block font-display text-2xl font-extrabold text-primary">
            {pool.length}
          </span>
          <span className="block text-[0.68rem] text-muted-foreground">
            {activeCount} active · {pool.length - activeCount} inactive
          </span>
        </button>
        <button
          type="button"
          aria-pressed={filters.status === "inactive"}
          onClick={() =>
            setFilters((f) => ({ ...f, status: f.status === "inactive" ? "all" : "inactive" }))
          }
          className={`rounded-xl border bg-card p-3 text-left transition hover:border-primary/60 ${filters.status === "inactive" ? "border-primary ring-2 ring-primary/30" : "border-border"}`}
        >
          <span className="flex items-center gap-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">
            <PowerOff size={13} className="text-muted-foreground" /> Inactive
          </span>
          <span className="mt-1 block font-display text-2xl font-extrabold text-muted-foreground">
            {pool.length - activeCount}
          </span>
          <span className="block text-[0.68rem] text-muted-foreground">Hidden from the shop</span>
        </button>
        <button
          type="button"
          aria-pressed={filters.outOfStock}
          disabled={stock === null}
          onClick={() => set("outOfStock", !filters.outOfStock)}
          className={`col-span-2 rounded-xl border bg-card p-3 text-left transition hover:border-primary/60 disabled:opacity-60 sm:col-span-1 ${filters.outOfStock ? "border-primary ring-2 ring-primary/30" : "border-border"}`}
        >
          <span className="flex items-center gap-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">
            <X size={13} className="text-destructive" /> Out of stock
          </span>
          <span className="mt-1 block font-display text-2xl font-extrabold text-destructive">
            {stock === null ? "–" : outCount}
          </span>
          <span className="block text-[0.68rem] text-muted-foreground">Nothing on hand</span>
        </button>
      </div>

      <div className="grid gap-2 rounded-xl border border-border bg-card p-3 md:grid-cols-[1fr_auto_auto_auto_auto] md:items-end">
        <div className="relative">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search products"
            placeholder="Search name, SKU or brand…"
            className="pl-9"
            value={filters.q}
            onChange={(e) => set("q", e.target.value)}
          />
        </div>
        <Select
          value={filters.category || ALL}
          onValueChange={(v) =>
            setFilters((f) => ({ ...f, category: v === ALL ? "" : v, subcategory: "" }))
          }
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
        <Select
          value={filters.subcategory || ALL}
          onValueChange={(v) => set("subcategory", v === ALL ? "" : v)}
          disabled={subcategories.length === 0}
        >
          <SelectTrigger aria-label="Subcategory" className="md:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All subcategories</SelectItem>
            {subcategories.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.status}
          onValueChange={(v) => set("status", v as ProductStatusFilter)}
        >
          <SelectTrigger aria-label="Active status" className="md:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Active and inactive</SelectItem>
            <SelectItem value="active">Active only</SelectItem>
            <SelectItem value="inactive">Inactive only</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 px-1 md:h-10">
          <Switch
            id="prod-out"
            checked={filters.outOfStock}
            disabled={stock === null}
            onCheckedChange={(v) => set("outOfStock", v)}
          />
          <Label htmlFor="prod-out" className="text-xs">
            Out of stock only
          </Label>
        </div>
      </div>

      {notice && (
        <div
          role={notice.error ? "alert" : "status"}
          className={
            "flex items-start justify-between gap-2 rounded-lg border px-4 py-3 text-xs " +
            (notice.error
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-primary/30 bg-primary/5 text-primary")
          }
        >
          <span>{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {stockFailed && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          Stock levels could not be loaded, so the out-of-stock filter is unavailable.
          <button
            type="button"
            className="inline-flex items-center gap-1 font-semibold text-primary underline"
            onClick={() => void refreshStock()}
          >
            <RefreshCw size={12} /> Try again
          </button>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex flex-wrap items-center gap-3">
          <span>
            {shown.length} of {pool.length} products
            {filtered && (
              <button
                type="button"
                className="ml-2 font-semibold text-primary underline"
                onClick={() => setFilters(DEFAULT_PRODUCT_FILTERS)}
              >
                Clear filters
              </button>
            )}
          </span>
          {archivedCount > 0 && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived ({archivedCount})
            </label>
          )}
        </span>
        {canEdit && selectable.length > 0 && (
          <label className="flex items-center gap-2 font-semibold text-foreground">
            <Checkbox
              aria-label="Select all"
              checked={allTicked ? true : selectedProducts.length > 0 ? "indeterminate" : false}
              onCheckedChange={toggleAll}
            />
            {allTicked ? "Clear selection" : `Select all ${selectable.length}`}
          </label>
        )}
      </div>

      {canEdit && selectedProducts.length > 0 && (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/40 bg-card p-3 shadow-sm"
        >
          <span className="text-sm font-semibold">{selectedProducts.length} selected</span>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void bulkSetActive(false)}
            >
              <PowerOff size={14} /> Make inactive
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void bulkSetActive(true)}>
              <Power size={14} /> Make active
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        </div>
      )}

      <ul className="grid gap-2" aria-label="Products">
        {shown.slice(0, limit).map((p) => {
          const archived = isArchived(p);
          const out = !archived && outIds.has(p.id);
          return (
            <li
              key={p.id}
              data-selected={selected.has(p.id) || undefined}
              className={`grid gap-3 rounded-xl border bg-card p-3 sm:items-center ${
                canEdit
                  ? "sm:grid-cols-[auto_minmax(0,1fr)_10rem_auto]"
                  : "sm:grid-cols-[minmax(0,1fr)_10rem_auto]"
              } ${selected.has(p.id) ? "border-primary bg-primary/5" : "border-border"}`}
            >
              {canEdit && (
                <Checkbox
                  aria-label={`Select ${p.name}`}
                  disabled={archived}
                  checked={selected.has(p.id)}
                  onCheckedChange={() => toggleOne(p.id)}
                />
              )}
              <div className="flex min-w-0 items-center gap-3">
                {p.image_url ? (
                  <img
                    src={p.image_url}
                    alt={p.name}
                    width={40}
                    height={40}
                    className="h-10 w-10 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <PackageOpen size={16} className="text-muted-foreground" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    <span className="font-mono">{p.sku ?? "—"}</span>
                    {" · "}
                    {[p.category, p.subcategory].filter(Boolean).join(" · ")}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {archived ? (
                      <Badge variant="outline">Archived</Badge>
                    ) : (
                      <Badge variant={p.is_active ? "default" : "secondary"}>
                        {p.is_active ? "Active" : "Inactive"}
                      </Badge>
                    )}
                    {out && (
                      <Badge
                        variant="outline"
                        className="border-destructive/30 bg-destructive/10 text-destructive"
                      >
                        Out of stock
                      </Badge>
                    )}
                    {p.regular_price_rand != null && (
                      <Badge variant="outline">
                        {p.sale_online_only ? "Sale · online only" : "Sale"}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
              <p className="text-sm sm:text-right">
                {p.regular_price_rand != null ? (
                  <span>
                    <s className="mr-1 text-muted-foreground">
                      {rand(Number(p.regular_price_rand))}
                    </s>
                    <b>{rand(Number(p.price_rand))}</b>
                  </span>
                ) : (
                  <b>{rand(Number(p.price_rand))}</b>
                )}
                {p.sold_by_weight && <span className="text-muted-foreground"> / g</span>}
              </p>
              <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                {canEdit && archived && (
                  <Button variant="ghost" size="sm" onClick={() => void restore(p)}>
                    Restore
                  </Button>
                )}
                {canEdit && !archived && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setEditingProduct(p.id)}>
                      Edit
                    </Button>
                    {p.is_active ? (
                      <Button variant="ghost" size="sm" onClick={() => void toggleActive(p)}>
                        Deactivate
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => void toggleActive(p)}>
                        Activate
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      aria-label={`Delete ${p.name}`}
                      onClick={() => setDeleting(p)}
                    >
                      <Trash2 size={14} /> Delete
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No products match. {filtered && "Try clearing the filters."}
        </p>
      )}
      {shown.length > limit && (
        <div className="text-center">
          <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
            Show {Math.min(PAGE, shown.length - limit)} more
          </Button>
        </div>
      )}
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && !busy && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  If this product was never sold, ordered or stocked, it is removed for good. This
                  can&apos;t be undone.
                </p>
                <p>
                  If it has sales, orders or stock history, it is <b>archived</b> instead: switched
                  off, removed from the shop, the till and these lists, while past sales, receipts
                  and reports stay correct. You can restore an archived product later.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {busy ? "Deleting…" : "Delete product"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {canEdit && (
        <ProductEditDialog
          products={products}
          editingProduct={editingProduct}
          setEditingProduct={setEditingProduct}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
