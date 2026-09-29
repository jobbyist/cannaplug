import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rand } from "@/lib/cart";
import {
  closePosSessionFn,
  completePosSaleFn,
  findPosSaleFn,
  getPosOverviewFn,
  openPosSessionFn,
  refundPosSaleFn,
  reviewPosSessionFn,
  upsertDrawerFn,
  voidPosSaleFn,
} from "@/lib/pos.functions";
import { StockControl } from "./StockControl";
import {
  TENDER_METHODS,
  addToCart,
  cartTotalCents,
  cashChangeCents,
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
  type TenderMethod,
  type TenderRow,
} from "./pos-logic";

type Overview = Awaited<ReturnType<typeof getPosOverviewFn>>;
type SaleView = Overview["sales"][number];
type CustomerOption = { id: string; full_name: string | null };

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

export function PosPanel({ customers }: { customers: CustomerOption[] }) {
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
        <OpenTill data={data} onChanged={refresh} />
      ) : (
        <>
          <SaleScreen
            data={data}
            session={data.mySession}
            customers={customers}
            onChanged={refresh}
          />
          <RecentSales data={data} session={data.mySession} onChanged={refresh} />
          <CloseTill session={data.mySession} onChanged={refresh} />
        </>
      )}

      {data.isManager && data.pendingApprovals.length > 0 && (
        <VarianceApprovals data={data} onChanged={refresh} />
      )}
      {data.isManager && <StockControl catalog={data.catalog} onChanged={refresh} />}
    </div>
  );
}

/* ----------------------------------------------------------------- open till */

function OpenTill({ data, onChanged }: { data: Overview; onChanged: () => Promise<void> }) {
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
            onChange={(e) => setDrawerId(e.target.value)}
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
      {error && <div className={`mt-3 ${errorClass}`}>{error}</div>}
      <Button className="mt-4" onClick={() => void open()} disabled={busy || !drawerId}>
        Open till
      </Button>
      {data.isManager && (
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
    items: { name: string; quantity: number; unit_price: number; line_total: number }[];
    tenders: { method: string; amount: number }[];
  };
  loyalty: { accrued: boolean; points?: number; reason?: string; pending?: boolean };
  cashReceivedCents: number | null;
};

function SaleScreen({
  data,
  session,
  customers,
  onChanged,
}: {
  data: Overview;
  session: NonNullable<Overview["mySession"]>;
  customers: CustomerOption[];
  onChanged: () => Promise<void>;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [tenders, setTenders] = useState<TenderRow[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [cashReceived, setCashReceived] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const keys = useRef(createKeyStore());

  const results = useMemo(() => searchCatalog(data.catalog, query, 8), [data.catalog, query]);
  useEffect(() => setHighlight(0), [query]);

  // Keep the cart consistent with refreshed availability (display only; the server re-checks).
  useEffect(() => {
    setLines((cur) =>
      cur.flatMap((l) => {
        const fresh = data.catalog.find((p) => p.id === l.product.id);
        return fresh
          ? [{ product: fresh, quantity: clampQuantity(l.quantity, fresh.available) }]
          : [];
      }),
    );
  }, [data.catalog]);

  const totalCents = cartTotalCents(lines);
  const status = tenderStatus(totalCents, tenders);
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
    if (inFlight.current || !status.ok || lines.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const items = lines.map((l) => ({ product_id: l.product.id, quantity: l.quantity }));
    const sendTenders = tenders.map((t) => ({
      method: t.method,
      amount: centsToAmount(parseCents(t.amount) ?? 0),
      ...(t.reference.trim() ? { reference: t.reference.trim() } : {}),
    }));
    const cid = customerId || null;
    // Same payload => same key (safe retry after a network failure); changed payload => new key.
    const key = keys.current.keyFor(salesSignature({ s: session.id, items, sendTenders, cid }));
    try {
      const res = await completePosSaleFn({
        data: { sessionId: session.id, items, tenders: sendTenders, customerId: cid, key },
      });
      setReceipt({ ...res, cashReceivedCents: parseCents(cashReceived) } as Receipt);
      keys.current.reset();
      setLines([]);
      setTenders([]);
      setCashReceived("");
      setCustomerId("");
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
        <ul id="pos-results" role="listbox" className="grid gap-1.5">
          {results.map((p, i) => (
            <li key={p.id} role="option" id={`pos-result-${p.id}`} aria-selected={i === highlight}>
              <button
                type="button"
                disabled={p.available <= 0}
                onClick={() => addProduct(p.id, parseQuickQuantity(query).quantity)}
                onMouseEnter={() => setHighlight(i)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${i === highlight ? "border-primary bg-primary/5" : "border-border hover:bg-muted"}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{p.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[p.category, p.subcategory, p.strain_type].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-bold">{rand(p.price_rand)}</span>
                  <span
                    className={`block text-[0.7rem] ${p.available <= 0 ? "text-destructive" : p.available <= 5 ? "text-amber-600" : "text-muted-foreground"}`}
                  >
                    {p.available <= 0 ? "Out of stock" : `${p.available} available`}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {results.length === 0 && (
            <li className="px-1 py-6 text-center text-xs text-muted-foreground">
              No matching products.
            </li>
          )}
        </ul>
        <p className="mt-3 text-[0.68rem] text-muted-foreground">
          Keys: <kbd>/</kbd> search · <kbd>↑</kbd>/<kbd>↓</kbd> choose · <kbd>Enter</kbd> add ·{" "}
          <kbd>F4</kbd> exact cash · <kbd>F9</kbd> complete sale
        </p>
      </div>

      {/* Cart + payment */}
      <div className="flex flex-col gap-4">
        {receipt && (
          <ReceiptCard
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
                      {money(Math.round(l.product.price_rand * 100) * l.quantity)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
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
            <label className="mb-3 grid gap-1.5 text-xs font-semibold">
              Customer (earns loyalty points, optional)
              <select
                className={selectClass}
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">Walk-in customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name ?? c.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>

            <div className="mb-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => quickTender("cash")}>
                <Banknote size={14} className="mr-1" /> Exact cash
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => quickTender("card")}>
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
                  <li key={t.rowId} className="grid grid-cols-[92px_1fr_auto] items-center gap-2">
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
                      onClick={() => setTenders((cur) => cur.filter((r) => r.rowId !== t.rowId))}
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
                {parseCents(cashReceived) !== null && parseCents(cashReceived)! >= cashTender && (
                  <span className="text-sm font-bold text-primary">
                    Change due: {money(cashChangeCents(parseCents(cashReceived)!, cashTender))}
                  </span>
                )}
              </label>
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
            {error && (
              <div className={`mt-3 ${errorClass}`} role="alert">
                {error}
              </div>
            )}
            <Button
              type="button"
              size="lg"
              className="mt-4 w-full"
              disabled={!status.ok || busy}
              onClick={() => void completeSale()}
            >
              {busy ? "Completing…" : `Complete sale · ${money(totalCents)} (F9)`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReceiptCard({ receipt, onNew }: { receipt: Receipt; onNew: () => void }) {
  const { sale, loyalty } = receipt;
  const cashPaid = sale.tenders
    .filter((t) => t.method === "cash")
    .reduce((s, t) => s + Math.round(t.amount * 100), 0);
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-5" role="status">
      <div className="mb-2 flex items-center gap-2 text-primary">
        <CheckCircle2 size={18} />
        <h2 className={headingClass}>Sale complete</h2>
      </div>
      <p className="font-display text-lg font-extrabold">{sale.receipt_number}</p>
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
  const [mode, setMode] = useState<null | "void" | "refund">(null);
  const canVoid = isManager && sale.status === "completed";
  const canRefund =
    isManager && (sale.status === "completed" || sale.status === "partially_refunded");
  return (
    <li className="list-none rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div>
          <p className="text-sm font-semibold">{sale.receipt_number}</p>
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
    (s, i) => s + Math.round(i.unit_price_rand * 100) * (qty[i.id] ?? 0),
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
                ({max} refundable @ {rand(i.unit_price_rand)})
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

/* --------------------------------------------------------------- close till */

function CloseTill({
  session,
  onChanged,
}: {
  session: NonNullable<Overview["mySession"]>;
  onChanged: () => Promise<void>;
}) {
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    expected_cash: number;
    actual_cash: number;
    variance: number;
    approval_status: string;
    sales_count: number;
  } | null>(null);
  const keys = useRef(createKeyStore());

  const close = async () => {
    const cents = parseCents(counted);
    if (cents === null) return setError("Enter the counted cash as a valid amount.");
    setBusy(true);
    setError(null);
    try {
      const amount = centsToAmount(cents);
      const r = (await closePosSessionFn({
        data: {
          sessionId: session.id,
          actualCash: amount,
          ...(note.trim() ? { note: note.trim() } : {}),
          key: keys.current.keyFor(`${session.id}:${amount}:${note}`),
        },
      })) as typeof result;
      setResult(r);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className={cardClass} role="status">
        <h2 className={`mb-3 ${headingClass}`}>Till closed</h2>
        <dl className="grid max-w-sm grid-cols-2 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Expected cash</dt>
          <dd className="text-right font-semibold">{rand(Number(result.expected_cash))}</dd>
          <dt className="text-muted-foreground">Counted cash</dt>
          <dd className="text-right font-semibold">{rand(Number(result.actual_cash))}</dd>
          <dt className="text-muted-foreground">Variance</dt>
          <dd
            className={`text-right font-bold ${Number(result.variance) === 0 ? "" : "text-destructive"}`}
          >
            {rand(Number(result.variance))}
          </dd>
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          {result.approval_status === "pending"
            ? "Variance is outside tolerance and needs manager approval."
            : "Within tolerance — no approval needed."}
        </p>
        <Button className="mt-3" size="sm" onClick={() => void onChanged()}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className={`${cardClass} max-w-xl`}>
      <h2 className={`mb-1 ${headingClass}`}>
        <Wallet size={14} className="mr-1 inline" /> Close till
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Count the cash in the drawer (including the float). Expected cash is revealed after you
        submit the count.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-semibold">
          Counted cash (R)
          <Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold">
          Note (optional)
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      {error && <div className={`mt-3 ${errorClass}`}>{error}</div>}
      <Button
        className="mt-3"
        variant="outline"
        disabled={busy || counted.trim() === ""}
        onClick={() => void close()}
      >
        Close till
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
