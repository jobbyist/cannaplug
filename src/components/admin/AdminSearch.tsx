import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, LayoutGrid, Package, Receipt, Search, User } from "lucide-react";
import { Input } from "@/components/ui/input";
import { adminSearchFn } from "@/lib/admin.functions";
import type { AdminSearchResults, SearchSale } from "@/lib/admin-search.server";
import { rand } from "@/lib/cart";
import { toHits, type SearchHit, type SearchTab } from "@/components/admin/admin-search-logic";
export type { SearchHit, SearchTab } from "@/components/admin/admin-search-logic";

const EMPTY: AdminSearchResults = { orders: [], customers: [], products: [], sales: [] };

const ICON = {
  tab: LayoutGrid,
  order: ClipboardList,
  customer: User,
  product: Package,
  sale: Receipt,
} as const;
const GROUP = {
  tab: "Go to",
  order: "Orders",
  customer: "Customers",
  product: "Products",
  sale: "Till sales",
} as const;

const serverSearch = (q: string) => adminSearchFn({ data: { q } }) as Promise<AdminSearchResults>;

/** The search box at the top of /admin: orders, customers, products, till receipts and tabs. Ctrl/⌘ K focuses it. */
export function AdminSearch({
  tabs,
  onOpen,
  search = serverSearch,
}: {
  tabs: SearchTab[];
  onOpen: (hit: SearchHit) => void;
  search?: (q: string) => Promise<AdminSearchResults>;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<AdminSearchResults>(EMPTY);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  // Debounced server search; stale responses are ignored.
  useEffect(() => {
    const term = q.trim();
    setActive(0);
    if (term.length < 2) {
      setResults(EMPTY);
      setBusy(false);
      return;
    }
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      search(term)
        .then((r) => live && (setResults(r), setError(null)))
        .catch((e) => live && setError(e instanceof Error ? e.message : "Search failed."))
        .finally(() => live && setBusy(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, search]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    const click = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", click);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", click);
    };
  }, []);

  const hits = useMemo(() => toHits(q, tabs, results), [q, tabs, results]);
  const choose = (hit: SearchHit) => {
    onOpen(hit);
    setOpen(false);
    setQ("");
    input.current?.blur();
  };
  const showPanel = open && q.trim().length >= 2;

  return (
    <div ref={box} className="relative w-full max-w-md">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        size={16}
      />
      <Input
        ref={input}
        className="pl-9 pr-14"
        placeholder="Search orders, customers, products, receipts…"
        aria-label="Search the admin panel"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls="admin-search-results"
        aria-autocomplete="list"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && hits[active]) {
            e.preventDefault();
            choose(hits[active]!);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-border px-1.5 text-[0.6rem] text-muted-foreground sm:block">
        Ctrl K
      </kbd>
      {showPanel && (
        <div
          id="admin-search-results"
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
        >
          {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
          {!error && hits.length === 0 && (
            <p className="px-3 py-3 text-xs text-muted-foreground" role="status">
              {busy ? "Searching…" : `Nothing found for "${q.trim()}".`}
            </p>
          )}
          {hits.map((hit, i) => {
            const Icon = ICON[hit.kind];
            const first = i === 0 || hits[i - 1]!.kind !== hit.kind;
            return (
              <div key={`${hit.kind}-${hit.id}`}>
                {first && (
                  <p className="px-3 pb-1 pt-2 text-[0.6rem] font-bold uppercase tracking-wider text-muted-foreground">
                    {GROUP[hit.kind]}
                  </p>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(hit)}
                  className={
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs " +
                    (i === active ? "bg-secondary" : "")
                  }
                >
                  <Icon size={15} className="shrink-0 text-primary" />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{hit.label}</span>
                    <span className="block truncate text-muted-foreground">{hit.detail}</span>
                  </span>
                </button>
              </div>
            );
          })}
          {busy && hits.length > 0 && (
            <p className="px-3 py-1 text-[0.65rem] text-muted-foreground">Updating…</p>
          )}
        </div>
      )}
    </div>
  );
}
