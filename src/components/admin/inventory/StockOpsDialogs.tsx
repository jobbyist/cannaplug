import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Minus, PackagePlus, Plus, ScanLine, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createKeyStore } from "@/components/admin/pos/pos-logic";
import type { InventoryRow } from "@/lib/inventory-logic";
import { ADD_REASONS, REMOVE_REASONS, findProducts } from "@/lib/stock-take-logic";
import type { StockOpsApi } from "./inventory-api";
import { QuantityStepper } from "./QuantityStepper";

const unitOf = (r: Pick<InventoryRow, "sold_by_weight">, n: number) =>
  r.sold_by_weight ? `${n} g` : `${n} unit${n === 1 ? "" : "s"}`;
const errorText = (e: unknown) =>
  e instanceof Error && e.message ? e.message : "That didn't work and nothing was changed.";

/**
 * Add or remove stock for one product, without choosing a batch: removals come out of the first-expiring batches
 * (never below what online orders hold), additions go to the newest batch. Managers only (the server checks too).
 */
export function QuickAdjustDialog({
  open,
  onOpenChange,
  mode,
  row,
  api,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: "add" | "remove";
  row: InventoryRow | null;
  api: StockOpsApi;
  onDone: (message: string) => Promise<void> | void;
}) {
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(createKeyStore());
  useEffect(() => {
    if (!open) return;
    setQty("");
    setReason("");
    setOther("");
    setError(null);
    keys.current.reset();
  }, [open, mode, row?.product_id]);
  if (!row) return null;

  const reasons = mode === "add" ? ADD_REASONS : REMOVE_REASONS;
  const n = Number(qty || 0);
  const why = reason === "Other" ? other.trim() : reason;
  const max = mode === "remove" ? Math.max(0, row.available) : 100000;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!Number.isInteger(n) || n < 1) return setError("Enter how many.");
    if (n > max)
      return setError(
        `Only ${unitOf(row, max)} can be removed (the rest is held for online orders).`,
      );
    if (why.length < 3) return setError("Choose or type a reason.");
    const delta = mode === "add" ? n : -n;
    setBusy(true);
    setError(null);
    try {
      const r = await api.quickAdjust({
        productId: row.product_id,
        delta,
        reason: why,
        key: keys.current.keyFor(JSON.stringify([row.product_id, delta, why])),
      });
      keys.current.reset();
      onOpenChange(false);
      await onDone(`${row.name}: ${r.before} → ${r.after} on hand.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{mode === "add" ? "Add stock" : "Remove stock"}</DialogTitle>
            <DialogDescription>
              {row.name} · {unitOf(row, row.on_hand)} on hand
              {row.held > 0 ? ` · ${unitOf(row, row.held)} held for online orders` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="quick-qty">
              {mode === "add" ? "How many to add?" : "How many to remove?"}
              {row.sold_by_weight ? " (grams)" : ""}
            </Label>
            <QuantityStepper
              id="quick-qty"
              label={mode === "add" ? "How many to add?" : "How many to remove?"}
              value={qty}
              onChange={setQty}
              min={0}
              max={max}
              quick={row.sold_by_weight ? [1, 5, 10] : [1, 5, 10]}
            />
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Reason</legend>
            <div className="flex flex-wrap gap-2">
              {[...reasons, "Other"].map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={reason === r}
                  onClick={() => setReason(r)}
                  className={
                    "min-h-10 rounded-full border px-3 text-sm " +
                    (reason === r
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background")
                  }
                >
                  {r}
                </button>
              ))}
            </div>
            {reason === "Other" && (
              <Input
                aria-label="Other reason"
                className="h-11"
                maxLength={300}
                value={other}
                onChange={(e) => setOther(e.target.value)}
              />
            )}
          </fieldset>
          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" size="lg" disabled={busy} className="w-full sm:w-auto">
              {mode === "add" ? <Plus size={16} /> : <Minus size={16} />}
              {busy
                ? "Saving…"
                : `${mode === "add" ? "Add" : "Remove"} ${n > 0 ? unitOf(row, n) : ""}`.trim()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Line = { productId: string; qty: string; cost: string; expires: string };

/**
 * A delivery: scan or search products, enter how many came in (and optionally cost and expiry), and receive them
 * all at once. Nothing is saved unless every line is valid.
 */
export function DeliveryDialog({
  open,
  onOpenChange,
  rows,
  api,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rows: InventoryRow[];
  api: StockOpsApi;
  onDone: (message: string) => Promise<void> | void;
}) {
  const [supplier, setSupplier] = useState("");
  const [reference, setReference] = useState("");
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(createKeyStore());
  const byId = useMemo(() => new Map(rows.map((r) => [r.product_id, r])), [rows]);
  const matches = useMemo(() => findProducts(rows, query), [rows, query]);
  useEffect(() => {
    if (!open) return;
    setSupplier("");
    setReference("");
    setQuery("");
    setLines([]);
    setError(null);
    keys.current.reset();
  }, [open]);

  const addProduct = (p: InventoryRow) => {
    setLines((ls) =>
      ls.some((l) => l.productId === p.product_id)
        ? ls.map((l) =>
            l.productId === p.product_id ? { ...l, qty: String(Number(l.qty || 0) + 1) } : l,
          )
        : [...ls, { productId: p.product_id, qty: "1", cost: "", expires: "" }],
    );
    setQuery("");
  };
  const update = (id: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.productId === id ? { ...l, ...patch } : l)));
  const units = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);

  const submit = async () => {
    setError(null);
    if (!lines.length) return setError("Add at least one product.");
    for (const l of lines) {
      const name = byId.get(l.productId)?.name ?? "A product";
      const q = Number(l.qty);
      if (!Number.isInteger(q) || q < 1) return setError(`${name}: enter how many came in.`);
      if (l.cost && !/^\d{1,7}(\.\d{1,2})?$/.test(l.cost))
        return setError(`${name}: the unit cost should look like 18.50.`);
    }
    const payload = {
      supplier: supplier.trim() || null,
      reference: reference.trim() || null,
      lines: lines.map((l) => ({
        productId: l.productId,
        quantity: Number(l.qty),
        unitCost: l.cost || null,
        expiresOn: l.expires || null,
      })),
    };
    setBusy(true);
    try {
      const r = await api.receiveDelivery({
        ...payload,
        key: keys.current.keyFor(JSON.stringify(payload)),
      });
      keys.current.reset();
      onOpenChange(false);
      await onDone(
        `Delivery received: ${r.lines} products, ${r.units} units (batch ${r.batch_code}).`,
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Receive a delivery</DialogTitle>
          <DialogDescription>
            Scan or search each product, then enter how many came in. Everything is saved together.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="del-supplier">Supplier (optional)</Label>
            <Input
              id="del-supplier"
              className="h-11"
              maxLength={120}
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="del-ref">Invoice or delivery note no. (optional)</Label>
            <Input
              id="del-ref"
              className="h-11"
              maxLength={40}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="del-scan">Scan a barcode or search a product</Label>
          <div className="relative">
            <ScanLine
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="del-scan"
              className="h-11 pl-9"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // A scanner types the code and presses Enter: take the single exact match.
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (matches.length >= 1) addProduct(matches[0]!);
                }
              }}
            />
          </div>
          {query.trim() && (
            <ul
              className="grid max-h-48 gap-1 overflow-y-auto rounded-md border border-border p-1"
              aria-label="Matching products"
            >
              {matches.length === 0 && (
                <li className="px-2 py-2 text-sm text-muted-foreground">No product matches.</li>
              )}
              {matches.map((m) => (
                <li key={m.product_id}>
                  <button
                    type="button"
                    onClick={() => addProduct(m)}
                    className="flex min-h-11 w-full items-center justify-between gap-2 rounded px-2 text-left text-sm hover:bg-muted"
                  >
                    <span className="truncate">{m.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{m.category}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {lines.length > 0 && (
          <ul className="grid gap-2" aria-label="Delivery lines">
            {lines.map((l) => {
              const p = byId.get(l.productId);
              return (
                <li key={l.productId} className="grid gap-2 rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold">{p?.name ?? "Product"}</p>
                    <button
                      type="button"
                      aria-label={`Remove ${p?.name ?? "product"} from the delivery`}
                      onClick={() =>
                        setLines((ls) => ls.filter((x) => x.productId !== l.productId))
                      }
                      className="grid h-10 w-10 place-items-center text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="grid gap-1">
                      <Label htmlFor={`q-${l.productId}`} className="text-xs">
                        {p?.sold_by_weight ? "Grams" : "Quantity"}
                      </Label>
                      <Input
                        id={`q-${l.productId}`}
                        inputMode="numeric"
                        className="h-11"
                        value={l.qty}
                        onChange={(e) =>
                          update(l.productId, { qty: e.target.value.replace(/\D/g, "") })
                        }
                      />
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor={`c-${l.productId}`} className="text-xs">
                        Unit cost (R)
                      </Label>
                      <Input
                        id={`c-${l.productId}`}
                        inputMode="decimal"
                        className="h-11"
                        value={l.cost}
                        onChange={(e) => update(l.productId, { cost: e.target.value.trim() })}
                      />
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor={`e-${l.productId}`} className="text-xs">
                        Expires
                      </Label>
                      <Input
                        id={`e-${l.productId}`}
                        type="date"
                        className="h-11"
                        value={l.expires}
                        onChange={(e) => update(l.productId, { expires: e.target.value })}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            size="lg"
            className="w-full sm:w-auto"
            disabled={busy || lines.length === 0}
            onClick={() => void submit()}
          >
            <PackagePlus size={16} />
            {busy
              ? "Receiving…"
              : `Receive ${lines.length} product${lines.length === 1 ? "" : "s"} (${units} units)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
