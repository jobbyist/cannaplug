import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { rand } from "@/lib/cart";
import { normKey } from "@/lib/catalogue-taxonomy";
import {
  SORTS,
  SORT_LABEL,
  activeFilters,
  facets,
  filterProducts,
  resolveShopSearch,
  sortProducts,
  withCategory,
  withoutFilter,
  type ShopSearch,
  type ShopSort,
} from "@/lib/shop-filter";
import { ProductCard, type StoreProduct } from "@/components/shop/ProductCard";

const pill =
  "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-xs font-semibold uppercase tracking-wide transition";
const pillOn = "border-primary bg-primary text-primary-foreground";
const pillOff = "border-border bg-background hover:border-primary hover:text-primary";

type Props = {
  products: StoreProduct[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** What the address bar says. */
  search: ShopSearch;
  /** Writes a new search to the address bar. */
  onSearch: (next: ShopSearch) => void;
};

/** The filters other than category, shown beside the results on a desktop and inside a sheet on a phone. */
function FilterControls({
  s,
  f,
  onSearch,
  idPrefix,
}: {
  s: ShopSearch;
  f: ReturnType<typeof facets>;
  onSearch: (next: ShopSearch) => void;
  idPrefix: string;
}) {
  const bounds = f.price;
  const lo = s.min !== undefined && bounds ? Math.max(bounds.min, s.min) : (bounds?.min ?? 0);
  const hi = s.max !== undefined && bounds ? Math.min(bounds.max, s.max) : (bounds?.max ?? 0);
  const [range, setRange] = useState<[number, number]>([lo, Math.max(lo, hi)]);
  useEffect(() => setRange([lo, Math.max(lo, hi)]), [lo, hi]);
  const showStrain = f.strains.some((x) => x.count > 0) || !!s.strain;

  return (
    <div className="grid gap-5">
      {showStrain && (
        <div className="grid gap-1.5">
          <Label
            htmlFor={`${idPrefix}-strain`}
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Strain type
          </Label>
          <Select
            value={s.strain ?? "all"}
            onValueChange={(v) => {
              const next = { ...s };
              if (v === "all") delete next.strain;
              else next.strain = v as NonNullable<ShopSearch["strain"]>;
              onSearch(next);
            }}
          >
            <SelectTrigger id={`${idPrefix}-strain`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All strains</SelectItem>
              {f.strains.map((x) => (
                <SelectItem
                  key={x.name}
                  value={x.name}
                  disabled={x.count === 0 && s.strain !== x.name}
                >
                  {x.name} ({x.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {bounds && bounds.max > bounds.min && (
        <div className="grid gap-2">
          <Label className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span>Price range</span>
            <span className="text-foreground" data-testid={`${idPrefix}-price-label`}>
              {rand(range[0])} – {rand(range[1])}
            </span>
          </Label>
          <Slider
            min={bounds.min}
            max={bounds.max}
            step={1}
            value={range}
            onValueChange={(v) => setRange([v[0] ?? bounds.min, v[1] ?? bounds.max])}
            onValueCommit={(v) => {
              const a = v[0] ?? bounds.min;
              const b = v[1] ?? bounds.max;
              const next = { ...s };
              if (a <= bounds.min) delete next.min;
              else next.min = a;
              if (b >= bounds.max) delete next.max;
              else next.max = b;
              onSearch(next);
            }}
            aria-label="Filter by price range"
          />
        </div>
      )}
      <div className="grid gap-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${idPrefix}-stock`}
            checked={!!s.stock}
            onCheckedChange={(c) => {
              const next = { ...s };
              if (c === true) next.stock = true;
              else delete next.stock;
              onSearch(next);
            }}
          />
          <Label htmlFor={`${idPrefix}-stock`} className="text-sm">
            In stock only <span className="text-muted-foreground">({f.inStock})</span>
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${idPrefix}-sale`}
            checked={!!s.sale}
            onCheckedChange={(c) => {
              const next = { ...s };
              if (c === true) next.sale = true;
              else delete next.sale;
              onSearch(next);
            }}
          />
          <Label htmlFor={`${idPrefix}-sale`} className="text-sm">
            On sale <span className="text-muted-foreground">({f.onSale})</span>
          </Label>
        </div>
      </div>
    </div>
  );
}

/** The shop page's content. It keeps no filter state: it shows what `search` says and asks `onSearch` to change it. */
export function ShopView({ products, loading, error, onRetry, search, onSearch }: Props) {
  const s = useMemo(() => resolveShopSearch(search, products), [search, products]);
  const f = useMemo(() => facets(products, s), [products, s]);
  const shown = useMemo(
    () => sortProducts(filterProducts(products, s), (s.sort ?? "featured") as ShopSort),
    [products, s],
  );
  const chips = activeFilters(s);
  const narrowing = chips.length + (s.category ? 1 : 0);
  const [draft, setDraft] = useState(s.q ?? "");
  const lastQ = useRef(s.q ?? "");
  useEffect(() => {
    // the address bar changed under us (back button, clear): follow it
    if ((s.q ?? "") !== lastQ.current) {
      lastQ.current = s.q ?? "";
      setDraft(s.q ?? "");
    }
  }, [s.q]);
  useEffect(() => {
    const clean = draft.replace(/\s+/g, " ").trim();
    if (clean === (s.q ?? "")) return;
    const t = window.setTimeout(() => {
      lastQ.current = clean;
      const next = { ...s };
      if (clean) next.q = clean;
      else delete next.q;
      onSearch(next);
    }, 250);
    return () => window.clearTimeout(t);
  }, [draft, s, onSearch]);

  const clearAll = () => {
    setDraft("");
    onSearch({});
  };
  const sub = s.category ? f.subcategories : [];

  return (
    <>
      <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_14rem]">
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search the menu"
            aria-label="Search products"
            className="h-11 pl-9"
          />
        </div>
        <Select
          value={s.sort ?? "featured"}
          onValueChange={(v) => {
            const next = { ...s };
            if (v === "featured") delete next.sort;
            else next.sort = v as NonNullable<ShopSearch["sort"]>;
            onSearch(next);
          }}
        >
          <SelectTrigger className="h-11" aria-label="Sort products">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((o) => (
              <SelectItem key={o} value={o}>
                {SORT_LABEL[o]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <nav
        aria-label="Categories"
        className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
      >
        <button
          type="button"
          aria-pressed={!s.category}
          onClick={() => onSearch(withCategory(s, undefined))}
          className={`${pill} ${!s.category ? pillOn : pillOff}`}
        >
          All <span className="opacity-70">{products.length}</span>
        </button>
        {f.categories.map((c) => {
          const on = normKey(s.category) === normKey(c.name);
          return (
            <button
              key={c.name}
              type="button"
              aria-pressed={on}
              onClick={() => onSearch(withCategory(s, c.name))}
              className={`${pill} ${on ? pillOn : pillOff} ${c.count === 0 && !on ? "opacity-50" : ""}`}
            >
              {c.name} <span className="opacity-70">{c.count}</span>
            </button>
          );
        })}
      </nav>

      {sub.length > 0 && (
        <nav
          aria-label={`${s.category} types`}
          className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
        >
          <button
            type="button"
            aria-pressed={!s.sub}
            onClick={() => onSearch(withoutFilter(s, "sub"))}
            className={`${pill} min-h-10 normal-case ${!s.sub ? pillOn : pillOff}`}
          >
            All {s.category}
          </button>
          {sub.map((x) => {
            const on = normKey(s.sub) === normKey(x.name);
            return (
              <button
                key={x.name}
                type="button"
                aria-pressed={on}
                onClick={() => onSearch({ ...s, sub: x.name })}
                className={`${pill} min-h-10 normal-case ${on ? pillOn : pillOff} ${x.count === 0 && !on ? "opacity-50" : ""}`}
              >
                {x.name} <span className="opacity-70">{x.count}</span>
              </button>
            );
          })}
        </nav>
      )}

      <div className="mb-6 grid gap-6 lg:grid-cols-[16rem_1fr]">
        <aside
          aria-label="Filters"
          className="hidden h-fit rounded-xl border border-border bg-card p-5 lg:block"
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-sm font-bold uppercase">Filters</h2>
            {narrowing > 0 && (
              <Button variant="ghost" size="sm" onClick={clearAll}>
                <RotateCcw size={13} /> Clear
              </Button>
            )}
          </div>
          <FilterControls s={s} f={f} onSearch={onSearch} idPrefix="desk" />
        </aside>

        <section aria-label="Products">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="min-h-11 lg:hidden">
                  <SlidersHorizontal size={14} /> Filters
                  {chips.length > 0 && (
                    <span className="ml-1 rounded-full bg-primary px-1.5 text-[0.65rem] text-primary-foreground">
                      {chips.length}
                    </span>
                  )}
                </Button>
              </SheetTrigger>
              <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
                <SheetHeader>
                  <SheetTitle>Filters</SheetTitle>
                  <SheetDescription>
                    {shown.length} {shown.length === 1 ? "product matches" : "products match"}
                  </SheetDescription>
                </SheetHeader>
                <div className="py-4">
                  <FilterControls s={s} f={f} onSearch={onSearch} idPrefix="sheet" />
                </div>
                <SheetFooter className="gap-2">
                  <Button variant="outline" onClick={clearAll}>
                    Clear all
                  </Button>
                </SheetFooter>
              </SheetContent>
            </Sheet>
            <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
              {loading
                ? "Loading the menu…"
                : `Showing ${shown.length} of ${products.length} products`}
            </p>
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => onSearch(withoutFilter(s, c.key))}
                aria-label={`Remove filter ${c.label}`}
                className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border bg-secondary px-3 text-xs font-semibold"
              >
                {c.label} <X size={12} />
              </button>
            ))}
            {narrowing > 1 && (
              <Button variant="ghost" size="sm" onClick={clearAll}>
                Clear all
              </Button>
            )}
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-xl border border-border bg-card py-14 text-center text-sm"
            >
              <p className="mb-3 text-muted-foreground">The menu couldn't be loaded.</p>
              <Button onClick={onRetry}>Try again</Button>
            </div>
          ) : loading ? (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-80 rounded-xl" />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <div className="rounded-xl border border-border bg-card py-14 text-center text-sm">
              <p className="mb-3 text-muted-foreground">No products match your filters.</p>
              <Button variant="outline" onClick={clearAll}>
                <RotateCcw size={13} /> Clear filters
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
