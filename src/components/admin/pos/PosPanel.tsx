import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  BadgePercent,
  Banknote,
  CheckCircle2,
  CreditCard,
  Minus,
  Plus,
  ReceiptText,
  Search,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StaffBadge } from "@/components/StaffBadge";
import type { PosCustomerRewards } from "@/lib/pos-data.server";
import { CustomerPicker, type PickedCustomer } from "@/components/admin/pos/CustomerPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rand } from "@/lib/cart";
import {
  closePosSessionFn,
  completePosSaleFn,
  findPosSaleFn,
  getPosCustomerRewardsFn,
  getPosOverviewFn,
  openPosSessionFn,
  refundPosSaleFn,
  reviewPosSessionFn,
  upsertDrawerFn,
  voidPosSaleFn,
} from "@/lib/pos.functions";
import { StockControl } from "./StockControl";
import { ReceiptActions } from "@/components/admin/receipts/ReceiptActions";
import { recordCashReceivedFn } from "@/lib/receipts.functions";
import {
  TENDER_METHODS,
  addToCart,
  STAFF_PERCENT,
  rewardCovers,
  cartSummary,
  discountCents,
  refundLineCents,
  sendableDiscount,
  type DiscountInput,
  cashChangeCents,
  categoryCounts,
  centsToAmount,
  clampQuantity,
  createKeyStore,
  defaultPayouts,
  parseCents,
  parseQuickQuantity,
  removeLine,
  salesSignature,
  searchCatalog,
  setLineQuantity,
  tenderStatus,
  type CartLine,
  type CatalogItem,
  type TenderMethod,
  type TenderRow,
} from "./pos-logic";
import { PosSaleDialog, type SetSale } from "./PosSaleDialog";
import { simulateSale, type DemoReceipt } from "./demo-logic";
import { CloseTill, TillExpenses } from "./TillCashup";
import { DiscountEditor } from "./DiscountEditor";
import { notifyAdminTabs, useAdminTabSync } from "@/lib/admin-sync";

type Overview = Awaited<ReturnType<typeof getPosOverviewFn>>;
type SaleView = Overview["sales"][number];

const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";
const cardClass = "rounded-xl border border-border bg-card p-5";
const headingClass = "font-display text-sm font-bold uppercase";
const errorClass =
  "rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive";
const money = (cents: number) => rand(cents / 100);
const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please retry.";
const uidRow = () => Math.random().toString(36).slice(2, 9);
const statusVariant = (s: string) =>
  s === "completed" ? "default" : s === "voided" ? "destructive" : "secondary";

export function PosPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await getPosOverviewFn());
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Another admin tab sold, refunded or received stock, or changed a price: reload the catalogue quietly.
  // The basket on this screen is kept (it is re-checked against the new stock and prices).
  useAdminTabSync(["stock", "products"], () => void refresh());
  const changed = useCallback(async () => {
    await refresh();
    notifyAdminTabs("stock");
  }, [refresh]);

  if (error && !data) return <div className={errorClass}>{error}</div>;
  if (!data) return <p className="text-xs text-muted-foreground">Loading point of sale…</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold uppercase">Point of sale</h1>
          <p className="text-sm text-muted-foreground">
            Prices, totals and stock are always calculated by the server; this screen only sends
            products and quantities.
          </p>
        </div>
        {data.mySession && (
          <Badge variant="secondary">
            Till open since{" "}
            {new Date(data.mySession.opened_at).toLocaleTimeString("en-ZA", {
              hour: "2-digit",
              minute: "2-digit",
            })}
            {data.sessionSummary
              ? ` · ${data.sessionSummary.salesCount} sales · ${rand(data.sessionSummary.salesTotal)}`
              : ""}
          </Badge>
        )}
      </div>
      {error && <div className={errorClass}>{error}</div>}

      {!data.mySession ? (
        <OpenTill data={data} onChanged={changed} />
      ) : (
        <>
          <SaleScreen data={data} session={data.mySession} onChanged={changed} />
          <RecentSales data={data} session={data.mySession} onChanged={changed} />
          <TillExpenses
            sessionId={data.mySession.id}
            cashup={data.sessionCashup}
            isManager={data.isManager}
            onChanged={changed}
          />
          <CloseTill session={data.mySession} cashup={data.sessionCashup} onChanged={changed} />
        </>
      )}

      {data.isManager && data.pendingApprovals.length > 0 && (
        <VarianceApprovals data={data} onChanged={changed} />
      )}
      {data.isManager && <StockControl catalog={data.catalog} onChanged={changed} />}
    </div>
  );
}

/* ----------------------------------------------------------------- open till */

export function OpenTill({
  data,
  onChanged,
  demoOpen,
}: {
  data: Pick<Overview, "drawers" | "isManager">;
  onChanged: () => Promise<void>;
  /** Demo till: opens a practice session in the browser instead of calling the server. */
  demoOpen?: (drawerId: string, openingFloat: string) => void;
}) {
  const free = data.drawers.filter((d) => d.is_active && !d.in_use);
  const [drawerId, setDrawerId] = useState("");
  const [float, setFloat] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(createKeyStore());
  const [newName, setNewName] = useState("");

  const open = async () => {
    const cents = parseCents(float);
    if (!drawerId || cents === null)
      return setError("Choose a drawer and enter a valid opening float.");
    setBusy(true);
    setError(null);
    try {
      const amount = centsToAmount(cents);
      if (demoOpen) {
        demoOpen(drawerId, amount);
        return;
      }
      await openPosSessionFn({
        data: { drawerId, openingFloat: amount, key: keys.current.keyFor(`${drawerId}:${amount}`) },
      });
      keys.current.reset();
      await onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const addDrawer = async () => {
    setBusy(true);
    setError(null);
    try {
      await upsertDrawerFn({
        data: { drawerId: null, name: newName, location: null, isActive: true },
      });
      setNewName("");
      await onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${cardClass} max-w-xl`}>
      <h2 className={`mb-1 ${headingClass}`}>Open till</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Count the float in the drawer, then open a session to start selling.
      </p>
      {free.length === 0 && (
        <p className="mb-3 text-xs text-muted-foreground">
          No free drawers.{" "}
          {data.isManager
            ? "Add one below."
            : "Ask a manager to add a drawer or close an open session."}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-semibold">
          Drawer
          <select
            className={selectClass}
            value={drawerId}
            onChange={(e) => {
              setDrawerId(e.target.value);
              // Start from the float left in this drawer after the last close's bank deposit.
              const carried = free.find((d) => d.id === e.target.value)?.carried_float;
              if (carried != null) setFloat(carried.toFixed(2));
            }}
          >
            <option value="">Select drawer…</option>
            {free.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.location ? ` · ${d.location}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-semibold">
          Opening float (R)
          <Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} />
        </label>
      </div>
      {(() => {
        const carried = free.find((d) => d.id === drawerId)?.carried_float;
        return carried != null ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Float left in this drawer at the last close: <b>{rand(carried)}</b>. Count it and
            correct the amount if it differs.
          </p>
        ) : null;
      })()}
      {error && <div className={`mt-3 ${errorClass}`}>{error}</div>}
      <Button className="mt-4" onClick={() => void open()} disabled={busy || !drawerId}>
        Open till
      </Button>
      {data.isManager && !demoOpen && (
        <div className="mt-6 border-t border-border pt-4">
          <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Add a drawer</p>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. Front counter"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button
              variant="outline"
              onClick={() => void addDrawer()}
              disabled={busy || newName.trim().length < 1}
            >
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- sale screen */

type Receipt = {
  sale: {
    sale_id: string;
    receipt_number: string;
    total: number;
    replayed?: boolean;
    staff_purchase?: boolean;
    items: { name: string; quantity: number; unit_price: number; line_total: number }[];
    tenders: { method: string; amount: number }[];
  };
  loyalty: { accrued: boolean; points?: number; reason?: string; pending?: boolean };
  cashReceivedCents: number | null;
};

/** Demo till: the same screen, but completing a sale only works it out in the browser (nothing is saved). */
export type DemoHooks = {
  nextReceiptNumber: () => string;
  onSold: (sale: { lines: CartLine[]; receipt: DemoReceipt; discountCents: number }) => void;
  setSale: SetSale;
};

export function SaleScreen({
  data,
  session,
  onChanged,
  demo,
}: {
  data: { catalog: CatalogItem[] };
  session: { id: string };
  onChanged: () => Promise<void>;
  demo?: DemoHooks;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [tenders, setTenders] = useState<TenderRow[]>([]);
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  // The attached member's points and the rewards on offer (loaded from the database, read-only).
  const [memberRewards, setMemberRewards] = useState<PosCustomerRewards | null>(null);
  const [orderDiscount, setOrderDiscount] = useState<DiscountInput | undefined>();
  const [discountReason, setDiscountReason] = useState("");
  const [cashReceived, setCashReceived] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const keys = useRef(createKeyStore());

  const [category, setCategory] = useState<string | null>(null);
  const [saleFor, setSaleFor] = useState<CatalogItem | null>(null);
  const [saleNotice, setSaleNotice] = useState<string | null>(null);
  const categories = useMemo(() => categoryCounts(data.catalog), [data.catalog]);
  // Typing narrows to the best 8; browsing a category shows more of it.
  const results = useMemo(
    () => searchCatalog(data.catalog, query, category && !query.trim() ? 40 : 8, category),
    [data.catalog, query, category],
  );
  useEffect(() => setHighlight(0), [query, category]);

  // Keep the cart consistent with refreshed availability (display only; the server re-checks).
  useEffect(() => {
    setLines((cur) =>
      cur.flatMap((l) => {
        const fresh = data.catalog.find((p) => p.id === l.product.id);
        return fresh
          ? [{ ...l, product: fresh, quantity: clampQuantity(l.quantity, fresh.available) }]
          : [];
      }),
    );
  }, [data.catalog]);

  useEffect(() => {
    setLines((cur) => (cur.some((l) => l.reward) ? cur.map(({ reward: _r, ...l }) => l) : cur));
    setMemberRewards(null);
    if (!customer) return;
    let alive = true;
    getPosCustomerRewardsFn({ data: { customerId: customer.id } })
      .then((r) => alive && setMemberRewards(r))
      .catch(() => alive && setMemberRewards(null));
    return () => {
      alive = false;
    };
  }, [customer?.id]);

  const offerFor = (p: CatalogItem) =>
    memberRewards?.rewards.find((r) => rewardCovers(r, p)) ?? null;
  const pointsUsed = lines.reduce(
    (sum, l) =>
      sum +
      (l.reward ? (memberRewards?.rewards.find((r) => r.code === l.reward)?.points_cost ?? 0) : 0),
    0,
  );
  const toggleReward = (productId: string, code: string | null) =>
    setLines((cur) =>
      cur.map((x) => {
        if (x.product.id !== productId) return x;
        const { reward: _r, discount: _d, ...rest } = x;
        return code ? { ...rest, reward: code } : rest;
      }),
    );

  const summary = cartSummary(lines, orderDiscount, customer?.staff === true);
  const totalCents = summary.totalCents;
  const reasonOk = !summary.hasManualDiscount || discountReason.trim().length >= 3;
  const discountsOk = summary.discountsValid && reasonOk;
  // A 100% discount makes a free (R0) sale: no payment is taken, whatever payment rows were typed before.
  const activeTenders = totalCents === 0 ? [] : tenders;
  const status = tenderStatus(totalCents, activeTenders);
  const cashTender = tenders
    .filter((t) => t.method === "cash")
    .reduce((s, t) => s + (parseCents(t.amount) ?? 0), 0);

  const focusSearch = () => searchRef.current?.focus();
  const addProduct = (id: string, quantity = 1) => {
    const p = data.catalog.find((c) => c.id === id);
    if (!p || p.available <= 0) return;
    setReceipt(null);
    setLines((cur) => addToCart(cur, p, quantity));
    setQuery("");
    focusSearch();
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = results[highlight];
      if (pick) addProduct(pick.id, parseQuickQuantity(query).quantity);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  };

  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const typing =
      t instanceof HTMLInputElement ||
      t instanceof HTMLSelectElement ||
      t instanceof HTMLTextAreaElement;
    if ((e.key === "/" && !typing) || e.key === "F2") {
      e.preventDefault();
      focusSearch();
    } else if (e.key === "F9" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      void completeSale();
    } else if (e.key === "F4") {
      e.preventDefault();
      quickTender("cash");
    }
  };

  const quickTender = (method: TenderMethod) => {
    if (totalCents <= 0) return;
    const remaining = status.remainingCents || totalCents;
    setTenders((cur) =>
      (cur.length === 1 && cur[0]!.amount === "" ? [] : cur).concat({
        rowId: uidRow(),
        method,
        amount: centsToAmount(remaining),
        reference: "",
      }),
    );
  };

  const completeSale = async () => {
    if (inFlight.current || !status.ok || !discountsOk || lines.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const items = lines.map((l) => {
      const discount = sendableDiscount(l.discount);
      return {
        product_id: l.product.id,
        quantity: l.quantity,
        ...(discount ? { discount } : {}),
        ...(l.reward ? { reward: l.reward } : {}),
      };
    });
    const od = sendableDiscount(orderDiscount);
    const reason = summary.hasManualDiscount ? discountReason.trim() : null;
    const sendTenders = activeTenders.map((t) => ({
      method: t.method,
      amount: centsToAmount(parseCents(t.amount) ?? 0),
      ...(t.reference.trim() ? { reference: t.reference.trim() } : {}),
    }));
    const cid = customer?.id ?? null;
    // Same payload => same key (safe retry after a network failure); changed payload => new key.
    const key = keys.current.keyFor(
      salesSignature({ s: session.id, items, sendTenders, cid, od, reason }),
    );
    try {
      if (demo) {
        // Practice sale: worked out here, never sent anywhere.
        const practice = simulateSale({
          lines,
          orderDiscount,
          tenders: activeTenders,
          receiptNumber: demo.nextReceiptNumber(),
          cashReceived,
          staff: customer?.staff === true,
        });
        setReceipt(practice as Receipt);
        demo.onSold({
          lines,
          receipt: practice,
          discountCents: summary.lineDiscountCents + summary.orderDiscountCents,
        });
        keys.current.reset();
        setLines([]);
        setTenders([]);
        setCashReceived("");
        setCustomer(null);
        setOrderDiscount(undefined);
        setDiscountReason("");
        focusSearch();
        return;
      }
      const res = await completePosSaleFn({
        data: {
          sessionId: session.id,
          items,
          tenders: sendTenders,
          customerId: cid,
          orderDiscount: od ?? null,
          discountReason: reason,
          key,
        },
      });
      const received = parseCents(cashReceived);
      setReceipt({ ...res, cashReceivedCents: received } as Receipt);
      // Best-effort: lets the printed/emailed receipt show cash received and change.
      if (received && res.sale?.sale_id)
        void recordCashReceivedFn({
          data: { saleId: res.sale.sale_id, cashReceived: received / 100 },
        }).catch(() => undefined);
      keys.current.reset();
      setLines([]);
      setTenders([]);
      setCashReceived("");
      setCustomer(null);
      setOrderDiscount(undefined);
      setDiscountReason("");
      await onChanged();
      focusSearch();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_400px]" onKeyDown={onPanelKey}>
      {/* Search + results */}
      <div className={cardClass}>
        <div className="relative mb-3">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            size={16}
          />
          <Input
            ref={searchRef}
            autoFocus
            className="h-11 pl-9 text-base"
            placeholder="Search product, strain or category…  ( / )   tip: 3*blue adds 3"
            aria-label="Search products"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            role="combobox"
            aria-expanded
            aria-controls="pos-results"
            aria-activedescendant={
              results[highlight] ? `pos-result-${results[highlight]!.id}` : undefined
            }
          />
        </div>
        <div
          className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1"
          role="group"
          aria-label="Filter by category"
        >
          {[{ category: null as string | null, count: data.catalog.length }, ...categories].map(
            (c) => (
              <button
                key={c.category ?? "all"}
                type="button"
                aria-pressed={category === c.category}
                onClick={() => {
                  setCategory(c.category);
                  searchRef.current?.focus();
                }}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition ${category === c.category ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}
              >
                {c.category ?? "All"} <span className="opacity-70">{c.count}</span>
              </button>
            ),
          )}
        </div>
        {saleNotice && (
          <p role="status" className="mb-2 rounded-lg bg-primary/5 px-3 py-2 text-xs text-primary">
            {saleNotice}
          </p>
        )}
        <ul id="pos-results" role="listbox" className="grid gap-1.5">
          {results.map((p, i) => (
            <li
              key={p.id}
              role="option"
              id={`pos-result-${p.id}`}
              aria-selected={i === highlight}
              className="flex items-stretch gap-1.5"
            >
              <button
                type="button"
                disabled={p.available <= 0}
                onClick={() => addProduct(p.id, parseQuickQuantity(query).quantity)}
                onMouseEnter={() => setHighlight(i)}
                className={`flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${i === highlight ? "border-primary bg-primary/5" : "border-border hover:bg-muted"}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{p.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[p.category, p.subcategory, p.strain_type].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-bold">
                    {p.regular_price_rand != null && (
                      <>
                        <span className="mr-1 rounded bg-[#D4AF37] px-1 text-[0.6rem] font-bold uppercase text-[#0B3D20]">
                          Sale
                        </span>
                        <s className="mr-1 text-xs font-normal text-muted-foreground">
                          {rand(p.regular_price_rand)}
                        </s>
                      </>
                    )}
                    {rand(p.price_rand)}
                  </span>
                  <span
                    className={`block text-[0.7rem] ${p.available <= 0 ? "text-destructive" : p.available <= 5 ? "text-amber-600" : "text-muted-foreground"}`}
                  >
                    {p.available <= 0 ? "Out of stock" : `${p.available} available`}
                  </span>
                </span>
              </button>
              <button
                type="button"
                title={p.regular_price_rand != null ? "Change or end the sale" : "Put on sale"}
                aria-label={`${p.regular_price_rand != null ? "Change sale for" : "Put on sale:"} ${p.name}`}
                onClick={() => setSaleFor(p)}
                className={`flex w-10 shrink-0 items-center justify-center rounded-lg border transition hover:bg-muted ${p.regular_price_rand != null ? "border-[#D4AF37] bg-[#D4AF37]/15 text-[#0B3D20]" : "border-border text-muted-foreground"}`}
              >
                <BadgePercent size={16} />
              </button>
            </li>
          ))}
          {results.length === 0 && (
            <li className="px-1 py-6 text-center text-xs text-muted-foreground">
              No matching products{category ? ` in ${category}` : ""}.
            </li>
          )}
        </ul>
        <PosSaleDialog
          {...(demo ? { setSale: demo.setSale } : {})}
          product={saleFor}
          onOpenChange={(o) => !o && setSaleFor(null)}
          onDone={async (m) => {
            setSaleNotice(m);
            await onChanged();
            notifyAdminTabs("products");
          }}
        />
        <p className="mt-3 text-[0.68rem] text-muted-foreground">
          Keys: <kbd>/</kbd> search · <kbd>↑</kbd>/<kbd>↓</kbd> choose · <kbd>Enter</kbd> add ·{" "}
          <kbd>F4</kbd> exact cash · <kbd>F9</kbd> complete sale
        </p>
      </div>

      {/* Cart + payment */}
      <div className="flex flex-col gap-4">
        {receipt && (
          <ReceiptCard
            demo={!!demo}
            receipt={receipt}
            onNew={() => {
              setReceipt(null);
              focusSearch();
            }}
          />
        )}
        <div className={cardClass}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className={headingClass}>Basket</h2>
            {lines.length > 0 && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-destructive"
                onClick={() => {
                  setLines([]);
                  setTenders([]);
                  setOrderDiscount(undefined);
                  setDiscountReason("");
                  focusSearch();
                }}
              >
                Clear
              </button>
            )}
          </div>
          {lines.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Search and press Enter to add products.
            </p>
          ) : (
            <ul className="grid gap-2">
              {lines.map((l) => (
                <li key={l.product.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{l.product.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {rand(l.product.price_rand)} each
                        {l.product.regular_price_rand != null && (
                          <> · sale (normally {rand(l.product.regular_price_rand)})</>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${l.product.name}`}
                      onClick={() => setLines((cur) => removeLine(cur, l.product.id))}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="Decrease quantity"
                        onClick={() =>
                          setLines((cur) => setLineQuantity(cur, l.product.id, l.quantity - 1))
                        }
                      >
                        <Minus size={14} />
                      </Button>
                      <Input
                        aria-label={`Quantity for ${l.product.name}`}
                        className="h-8 w-14 text-center"
                        inputMode="numeric"
                        value={l.quantity}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => {
                          const n = Number(e.target.value.replace(/\D/g, ""));
                          if (n > 0) setLines((cur) => setLineQuantity(cur, l.product.id, n));
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowUp" || e.key === "+" || e.key === "=") {
                            e.preventDefault();
                            setLines((cur) => setLineQuantity(cur, l.product.id, l.quantity + 1));
                          } else if (e.key === "ArrowDown" || e.key === "-") {
                            e.preventDefault();
                            setLines((cur) => setLineQuantity(cur, l.product.id, l.quantity - 1));
                          } else if (e.key === "Delete") {
                            e.preventDefault();
                            setLines((cur) => removeLine(cur, l.product.id));
                            focusSearch();
                          } else if (e.key === "Enter") {
                            e.preventDefault();
                            e.stopPropagation();
                            focusSearch();
                          }
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="Increase quantity"
                        disabled={l.quantity >= l.product.available}
                        onClick={() =>
                          setLines((cur) => setLineQuantity(cur, l.product.id, l.quantity + 1))
                        }
                      >
                        <Plus size={14} />
                      </Button>
                    </div>
                    <p className="text-sm font-bold">
                      {money(
                        Math.round(l.product.price_rand * 100) * l.quantity -
                          (l.reward
                            ? Math.round(l.product.price_rand * 100)
                            : (discountCents(
                                l.discount,
                                Math.round(l.product.price_rand * 100) * l.quantity,
                              ) ?? 0)),
                      )}
                    </p>
                  </div>
                  {(() => {
                    const offer = offerFor(l.product);
                    if (!offer) return null;
                    if (l.reward)
                      return (
                        <div
                          data-testid="reward-applied"
                          className="mt-2 flex items-center justify-between rounded-md bg-primary/10 px-2 py-1.5 text-xs"
                        >
                          <span className="font-semibold text-primary">
                            1 free ({offer.points_cost} points)
                          </span>
                          <button
                            type="button"
                            className="font-semibold text-muted-foreground hover:text-destructive"
                            onClick={() => toggleReward(l.product.id, null)}
                          >
                            Remove reward
                          </button>
                        </div>
                      );
                    const left = (memberRewards?.points ?? 0) - pointsUsed;
                    return (
                      <button
                        type="button"
                        disabled={left < offer.points_cost}
                        onClick={() => toggleReward(l.product.id, offer.code)}
                        className="mt-2 w-full rounded-md border border-dashed border-primary/50 px-2 py-1.5 text-left text-xs font-semibold text-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:border-border disabled:text-muted-foreground disabled:hover:bg-transparent"
                      >
                        Use reward: 1 free for {offer.points_cost} points
                        {left < offer.points_cost
                          ? ` (needs ${offer.points_cost - left} more)`
                          : ""}
                      </button>
                    );
                  })()}
                  {!l.reward && (
                    <details className="mt-2" open={Boolean(l.discount)}>
                      <summary className="cursor-pointer text-xs font-semibold text-primary">
                        Discount this item
                      </summary>
                      <div className="mt-1.5">
                        <DiscountEditor
                          label={`Discount for ${l.product.name}`}
                          value={l.discount}
                          invalid={
                            discountCents(
                              l.discount,
                              Math.round(l.product.price_rand * 100) * l.quantity,
                            ) === null
                          }
                          onChange={(d) =>
                            setLines((cur) =>
                              cur.map((x) =>
                                x.product.id === l.product.id ? { ...x, discount: d } : x,
                              ),
                            )
                          }
                        />
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}

          {lines.length > 0 && (
            <div className="mt-4 grid gap-2 border-t border-border pt-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  Discount whole order
                </span>
                <DiscountEditor
                  label="Order discount"
                  value={orderDiscount}
                  invalid={!summary.discountsValid && Boolean(orderDiscount)}
                  onChange={setOrderDiscount}
                />
              </div>
              {summary.hasDiscount && (
                <>
                  {summary.hasManualDiscount && (
                    <label className="grid gap-1 text-xs font-semibold">
                      Reason for discount (required)
                      <Input
                        aria-label="Discount reason"
                        className="h-8 text-sm"
                        maxLength={200}
                        placeholder="e.g. Loyal customer, damaged packaging"
                        value={discountReason}
                        onChange={(e) => setDiscountReason(e.target.value)}
                      />
                      <span className="font-normal text-muted-foreground">
                        Do not enter health or ID details.
                      </span>
                    </label>
                  )}
                  {summary.staffDiscountCents > 0 && (
                    <p
                      data-testid="staff-rate-note"
                      className="flex items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      <StaffBadge /> Staff rate: {STAFF_PERCENT}% off is applied automatically
                      {summary.orderDiscountCents > summary.staffDiscountCents
                        ? " (the larger typed order discount applies instead)"
                        : ""}
                      .
                    </p>
                  )}
                  {summary.rewardDiscountCents > 0 && (
                    <p
                      data-testid="reward-note"
                      className="flex items-center justify-between text-xs text-muted-foreground"
                    >
                      <span>
                        Loyalty reward: {pointsUsed} of {memberRewards?.points ?? 0} points used
                      </span>
                      <span>−{money(summary.rewardDiscountCents)}</span>
                    </p>
                  )}
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Subtotal</span>
                    <span>{money(summary.grossCents)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-primary">
                    <span>Discounts</span>
                    <span>−{money(summary.lineDiscountCents + summary.orderDiscountCents)}</span>
                  </div>
                </>
              )}
              {!summary.discountsValid && (
                <p role="alert" className="text-xs text-destructive">
                  Check the discount: it must be a number and no more than what it applies to.
                </p>
              )}
            </div>
          )}
          <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
            <span className="text-xs font-semibold uppercase text-muted-foreground">Total</span>
            <span className="font-display text-2xl font-extrabold">{money(totalCents)}</span>
          </div>
          <p className="mt-1 text-[0.68rem] text-muted-foreground">
            Final total is confirmed by the server when you complete the sale.
          </p>
        </div>

        {lines.length > 0 && (
          <div className={cardClass}>
            <h2 className={`mb-3 ${headingClass}`}>Payment</h2>
            <div className="mb-3 grid gap-1.5 text-xs font-semibold">
              <span>Customer (earns loyalty points, optional)</span>
              <CustomerPicker value={customer} onChange={setCustomer} />
              {customer && memberRewards && (
                <p
                  data-testid="member-points"
                  className="text-[0.7rem] font-normal text-muted-foreground"
                >
                  {customer.name} has <b>{memberRewards.points}</b> loyalty point
                  {memberRewards.points === 1 ? "" : "s"}
                  {memberRewards.rewards.length
                    ? ` · rewards from ${Math.min(...memberRewards.rewards.map((r) => r.points_cost))} points`
                    : ""}
                  . Earns 1 point per R50.
                </p>
              )}
            </div>

            {totalCents === 0 ? (
              <p
                role="status"
                className="mb-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs"
              >
                This sale is free (100% discount), so there is nothing to pay. Complete it to record
                the stock going out and the discount reason.
              </p>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => quickTender("cash")}
                  >
                    <Banknote size={14} className="mr-1" /> Exact cash
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => quickTender("card")}
                  >
                    <CreditCard size={14} className="mr-1" /> Exact card
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setTenders((cur) => [
                        ...cur,
                        {
                          rowId: uidRow(),
                          method: "cash",
                          amount: status.remainingCents ? centsToAmount(status.remainingCents) : "",
                          reference: "",
                        },
                      ])
                    }
                  >
                    <Plus size={14} className="mr-1" /> Split tender
                  </Button>
                </div>

                <ul className="grid gap-2">
                  {tenders.map((t) => {
                    const needsRef = TENDER_METHODS.find((m) => m.id === t.method)!.needsReference;
                    const update = (patch: Partial<TenderRow>) =>
                      setTenders((cur) =>
                        cur.map((r) => (r.rowId === t.rowId ? { ...r, ...patch } : r)),
                      );
                    return (
                      <li
                        key={t.rowId}
                        className="grid grid-cols-[92px_1fr_auto] items-center gap-2"
                      >
                        <select
                          aria-label="Tender method"
                          className={selectClass}
                          value={t.method}
                          onChange={(e) =>
                            update({ method: e.target.value as TenderMethod, reference: "" })
                          }
                        >
                          {TENDER_METHODS.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                        <Input
                          aria-label="Tender amount"
                          inputMode="decimal"
                          placeholder="0.00"
                          value={t.amount}
                          onChange={(e) => update({ amount: e.target.value })}
                          className="h-9"
                        />
                        <button
                          type="button"
                          aria-label="Remove tender"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() =>
                            setTenders((cur) => cur.filter((r) => r.rowId !== t.rowId))
                          }
                        >
                          <X size={15} />
                        </button>
                        {needsRef && (
                          <Input
                            aria-label={`${t.method} reference`}
                            className="col-span-3 h-9"
                            placeholder={
                              t.method === "card"
                                ? "Card slip / RRN reference"
                                : t.method === "eft"
                                  ? "EFT proof / bank reference"
                                  : "PayPal transaction ID"
                            }
                            value={t.reference}
                            onChange={(e) => update({ reference: e.target.value })}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>

                {cashTender > 0 && (
                  <label className="mt-3 grid gap-1.5 text-xs font-semibold">
                    Cash received (for change)
                    <Input
                      inputMode="decimal"
                      placeholder="0.00"
                      value={cashReceived}
                      onChange={(e) => setCashReceived(e.target.value)}
                      className="h-9"
                    />
                    {parseCents(cashReceived) !== null &&
                      parseCents(cashReceived)! >= cashTender && (
                        <span className="text-sm font-bold text-primary">
                          Change due:{" "}
                          {money(cashChangeCents(parseCents(cashReceived)!, cashTender))}
                        </span>
                      )}
                  </label>
                )}
              </>
            )}

            <div className="mt-3 flex justify-between text-xs">
              <span className="text-muted-foreground">Tendered {money(status.sumCents)}</span>
              {status.remainingCents > 0 && (
                <span className="font-semibold text-amber-600">
                  Remaining {money(status.remainingCents)}
                </span>
              )}
              {status.overCents > 0 && (
                <span className="font-semibold text-destructive">
                  Over by {money(status.overCents)}
                </span>
              )}
              {status.ok && <span className="font-semibold text-primary">Balanced</span>}
            </div>
            {status.duplicateReference && (
              <div className={`mt-3 ${errorClass}`} role="alert">
                The reference “{status.duplicateReference}” is on more than one payment. Each card
                or EFT payment needs its own slip or bank reference (the one printed on its own
                slip).
              </div>
            )}
            {error && (
              <div className={`mt-3 ${errorClass}`} role="alert">
                {error}
              </div>
            )}
            <Button
              type="button"
              size="lg"
              className="mt-4 w-full"
              disabled={!status.ok || !discountsOk || busy}
              onClick={() => void completeSale()}
            >
              {busy
                ? "Completing…"
                : `${totalCents === 0 ? "Complete free sale" : "Complete sale"} · ${money(totalCents)} (F9)`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReceiptCard({
  receipt,
  onNew,
  demo = false,
}: {
  receipt: Receipt;
  onNew: () => void;
  demo?: boolean;
}) {
  const { sale, loyalty } = receipt;
  const cashPaid = sale.tenders
    .filter((t) => t.method === "cash")
    .reduce((s, t) => s + Math.round(t.amount * 100), 0);
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-5" role="status">
      <div className="mb-2 flex items-center gap-2 text-primary">
        <CheckCircle2 size={18} />
        <h2 className={headingClass}>{demo ? "Demo sale complete" : "Sale complete"}</h2>
      </div>
      <p className="flex items-center gap-2 font-display text-lg font-extrabold">
        {sale.receipt_number}
        {sale.staff_purchase && <StaffBadge />}
      </p>
      <ul className="mt-2 text-xs">
        {sale.items.map((i) => (
          <li key={i.name} className="flex justify-between py-0.5">
            <span>
              {i.quantity} × {i.name}
            </span>
            <span>{rand(i.line_total)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex justify-between border-t border-border pt-2 text-sm font-bold">
        <span>Total</span>
        <span>{rand(sale.total)}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {sale.tenders.map((t) => `${t.method} ${rand(t.amount)}`).join(" · ")}
      </p>
      {receipt.cashReceivedCents !== null &&
        cashPaid > 0 &&
        receipt.cashReceivedCents >= cashPaid && (
          <p className="mt-1 text-xs font-semibold">
            Change given: {money(cashChangeCents(receipt.cashReceivedCents, cashPaid))}
          </p>
        )}
      {sale.replayed && (
        <p className="mt-1 text-xs text-muted-foreground">
          This request was already processed — showing the original receipt (no second charge).
        </p>
      )}
      {loyalty.accrued && (
        <p className="mt-1 text-xs text-primary">+{loyalty.points} loyalty points credited.</p>
      )}
      {loyalty.pending && (
        <p className="mt-1 text-xs text-amber-600">
          Sale saved. Loyalty points will be credited on retry.
        </p>
      )}
      {demo ? (
        <p className="mt-2 rounded-md bg-gold/15 p-2 text-xs font-semibold">
          Practice receipt only. Nothing was saved, printed or emailed.
        </p>
      ) : (
        <ReceiptActions saleId={sale.sale_id} />
      )}
      <Button type="button" className="mt-3" size="sm" onClick={onNew}>
        New sale (N)
      </Button>
    </div>
  );
}

/* ------------------------------------------------- recent sales, void, refund */

function RecentSales({
  data,
  session,
  onChanged,
}: {
  data: Overview;
  session: NonNullable<Overview["mySession"]>;
  onChanged: () => Promise<void>;
}) {
  const [lookup, setLookup] = useState("");
  const [found, setFound] = useState<SaleView | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const find = async () => {
    setLookupError(null);
    setFound(null);
    try {
      const sale = await findPosSaleFn({ data: { receipt: lookup } });
      if (!sale) setLookupError("No sale found with that receipt number.");
      else setFound(sale as SaleView);
    } catch (e) {
      setLookupError(errMsg(e));
    }
  };

  return (
    <div className={cardClass}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className={headingClass}>This session's sales</h2>
        {data.isManager && (
          <div className="flex gap-2">
            <Input
              className="h-8 w-48"
              placeholder="Find receipt POS-…"
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void find()}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void find()}
              disabled={lookup.trim().length < 4}
            >
              Find
            </Button>
          </div>
        )}
      </div>
      {lookupError && <div className={`mb-3 ${errorClass}`}>{lookupError}</div>}
      {found && (
        <SaleCard
          sale={found}
          sessionId={session.id}
          isManager={data.isManager}
          onChanged={async () => {
            setFound(null);
            await onChanged();
          }}
        />
      )}
      {data.sales.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          No sales yet in this session.
        </p>
      ) : (
        <ul className="grid gap-2">
          {data.sales.map((s) => (
            <SaleCard
              key={s.id}
              sale={s}
              sessionId={session.id}
              isManager={data.isManager}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SaleCard({
  sale,
  sessionId,
  isManager,
  onChanged,
}: {
  sale: SaleView;
  sessionId: string;
  isManager: boolean;
  onChanged: () => Promise<void>;
}) {
  const [mode, setMode] = useState<null | "void" | "refund" | "receipt">(null);
  const canVoid = isManager && sale.status === "completed";
  // A free (R0) sale has nothing to pay back: to put the stock back, void it.
  const canRefund =
    isManager &&
    Number(sale.total) > 0 &&
    (sale.status === "completed" || sale.status === "partially_refunded");
  return (
    <li className="list-none rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold">
            {sale.receipt_number}
            {sale.staff_purchase && <StaffBadge />}
          </p>
          <p className="text-muted-foreground">
            {new Date(sale.created_at).toLocaleString("en-ZA", {
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            · {sale.tenders.map((t) => `${t.method} ${rand(t.amount)}`).join(", ")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={statusVariant(sale.status)}>{sale.status.replace("_", " ")}</Badge>
          <span className="text-sm font-bold">{rand(sale.total)}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMode(mode === "receipt" ? null : "receipt")}
          >
            Receipt
          </Button>
          {canVoid && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMode(mode === "void" ? null : "void")}
            >
              Void
            </Button>
          )}
          {canRefund && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMode(mode === "refund" ? null : "refund")}
            >
              Refund
            </Button>
          )}
        </div>
      </div>
      <ul className="mt-1 text-xs text-muted-foreground">
        {sale.items.map((i) => (
          <li key={i.id}>
            {i.quantity} × {i.product_name}
            {i.refunded_quantity > 0 ? ` (${i.refunded_quantity} refunded)` : ""}
          </li>
        ))}
      </ul>
      {mode === "receipt" && <ReceiptActions saleId={sale.id} />}
      {mode === "void" && (
        <VoidForm
          sale={sale}
          onDone={async () => {
            setMode(null);
            await onChanged();
          }}
        />
      )}
      {mode === "refund" && (
        <RefundForm
          sale={sale}
          sessionId={sessionId}
          onDone={async () => {
            setMode(null);
            await onChanged();
          }}
        />
      )}
    </li>
  );
}

function VoidForm({ sale, onDone }: { sale: SaleView; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(createKeyStore());
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await voidPosSaleFn({
        data: { saleId: sale.id, reason, key: keys.current.keyFor(`${sale.id}:${reason}`) },
      });
      await onDone();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 grid gap-2 rounded-lg bg-muted/40 p-3">
      <p className="text-xs">
        Voiding returns all stock and reverses any loyalty points. It is recorded in the audit log.
      </p>
      <Input
        placeholder="Reason for void (required)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <div className={errorClass}>{error}</div>}
      <Button
        size="sm"
        variant="destructive"
        disabled={busy || reason.trim().length < 3}
        onClick={() => void submit()}
      >
        Confirm void
      </Button>
    </div>
  );
}

function RefundForm({
  sale,
  sessionId,
  onDone,
}: {
  sale: SaleView;
  sessionId: string;
  onDone: () => Promise<void>;
}) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState("");
  const [manual, setManual] = useState<
    { rowId: string; method: TenderMethod; amount: string; reference: string }[] | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(createKeyStore());

  const refundCents = sale.items.reduce(
    (s, i) => s + refundLineCents(i.line_total, i.quantity, i.refunded_quantity, qty[i.id] ?? 0),
    0,
  );
  const capacity = useMemo(() => {
    const cap: Partial<Record<TenderMethod, number>> = {};
    for (const t of sale.tenders)
      cap[t.method as TenderMethod] =
        (cap[t.method as TenderMethod] ?? 0) + Math.round(t.amount * 100);
    return cap;
  }, [sale.tenders]);
  const auto = useMemo(
    () =>
      defaultPayouts(refundCents, capacity).map((p) => ({
        rowId: p.method,
        method: p.method,
        amount: centsToAmount(p.cents),
        reference: "",
      })),
    [refundCents, capacity],
  );
  const payouts = manual ?? auto;
  const payoutSum = payouts.reduce((s, p) => s + (parseCents(p.amount) ?? 0), 0);
  const items = sale.items
    .filter((i) => (qty[i.id] ?? 0) > 0)
    .map((i) => ({ sale_item_id: i.id, quantity: qty[i.id]! }));
  const ready =
    items.length > 0 && refundCents > 0 && payoutSum === refundCents && reason.trim().length >= 3;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const body = {
      saleId: sale.id,
      sessionId,
      items,
      payouts: payouts.map((p) => ({
        method: p.method,
        amount: centsToAmount(parseCents(p.amount) ?? 0),
        ...(p.reference.trim() ? { reference: p.reference.trim() } : {}),
      })),
      reason,
      restock,
    };
    try {
      await refundPosSaleFn({ data: { ...body, key: keys.current.keyFor(salesSignature(body)) } });
      await onDone();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 grid gap-3 rounded-lg bg-muted/40 p-3 text-xs">
      <p>
        Choose what is being returned. The refund amount is calculated from the original sale price,
        never typed in.
      </p>
      {sale.items.map((i) => {
        const max = i.quantity - i.refunded_quantity;
        return (
          <label key={i.id} className="flex items-center justify-between gap-3">
            <span>
              {i.product_name}{" "}
              <span className="text-muted-foreground">
                ({max} refundable @ {rand(i.unit_price_rand)}
                {i.line_total < i.unit_price_rand * i.quantity ? ", discounted sale" : ""})
              </span>
            </span>
            <Input
              className="h-8 w-16 text-center"
              inputMode="numeric"
              disabled={max <= 0}
              value={qty[i.id] ?? 0}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) =>
                setQty((cur) => ({
                  ...cur,
                  [i.id]: Math.min(max, Number(e.target.value.replace(/\D/g, "")) || 0),
                }))
              }
            />
          </label>
        );
      })}
      <div className="flex justify-between text-sm font-bold">
        <span>Refund total</span>
        <span>{money(refundCents)}</span>
      </div>
      <div className="grid gap-1.5">
        <p className="font-semibold">Pay out via</p>
        {payouts.map((p) => (
          <div key={p.rowId} className="grid grid-cols-[92px_1fr] gap-2">
            <select
              className={selectClass}
              value={p.method}
              onChange={(e) =>
                setManual(
                  payouts.map((x) =>
                    x.rowId === p.rowId ? { ...x, method: e.target.value as TenderMethod } : x,
                  ),
                )
              }
            >
              {TENDER_METHODS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <Input
              className="h-9"
              inputMode="decimal"
              value={p.amount}
              onChange={(e) =>
                setManual(
                  payouts.map((x) => (x.rowId === p.rowId ? { ...x, amount: e.target.value } : x)),
                )
              }
            />
          </div>
        ))}
        {refundCents > 0 && payoutSum !== refundCents && (
          <p className="text-destructive">
            Payouts must equal the refund total ({money(refundCents)}).
          </p>
        )}
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />{" "}
        Return items to stock
      </label>
      <Input
        placeholder="Reason for refund (required)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <div className={errorClass}>{error}</div>}
      <Button size="sm" disabled={!ready || busy} onClick={() => void submit()}>
        Confirm refund
      </Button>
    </div>
  );
}

/* -------------------------------------------------------- variance approval */

function VarianceApprovals({
  data,
  onChanged,
}: {
  data: Overview;
  onChanged: () => Promise<void>;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const decide = async (sessionId: string, approve: boolean) => {
    setError(null);
    try {
      await reviewPosSessionFn({ data: { sessionId, approve, note: notes[sessionId] ?? "" } });
      await onChanged();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  return (
    <div className={cardClass}>
      <h2 className={`mb-3 ${headingClass}`}>
        <ReceiptText size={14} className="mr-1 inline" /> Cash variance approvals
      </h2>
      {error && <div className={`mb-3 ${errorClass}`}>{error}</div>}
      <ul className="grid gap-3">
        {data.pendingApprovals.map((s) => (
          <li key={s.id} className="rounded-lg border border-border p-3 text-xs">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-semibold">
                {s.drawer_name} · {s.cashier_name ?? "Cashier"}
              </span>
              <span>
                Expected {rand(s.expected_cash)} · Counted {rand(s.actual_cash)} ·{" "}
                <b className="text-destructive">Variance {rand(s.variance)}</b>
              </span>
            </div>
            <div className="mt-2 flex gap-2">
              <Input
                className="h-8"
                placeholder="Decision note (required)"
                value={notes[s.id] ?? ""}
                onChange={(e) => setNotes((cur) => ({ ...cur, [s.id]: e.target.value }))}
              />
              <Button
                size="sm"
                disabled={(notes[s.id] ?? "").trim().length < 3}
                onClick={() => void decide(s.id, true)}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={(notes[s.id] ?? "").trim().length < 3}
                onClick={() => void decide(s.id, false)}
              >
                Reject
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
