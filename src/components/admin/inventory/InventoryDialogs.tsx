import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, PackagePlus, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { centsToAmount, createKeyStore, parseCents } from "@/components/admin/pos/pos-logic";
import {
  ADJUST_REASONS,
  MOVEMENT_LABEL,
  adjustmentPreview,
  adjustmentReasonText,
  suggestBatchCode,
  type AdjustMode,
  type AdjustReason,
  type InventoryRow,
} from "@/lib/inventory-logic";
import type { Batch, InventoryApi, StockMovement } from "./inventory-api";
import { QuantityStepper } from "./QuantityStepper";

const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please retry.";
const NEW_BATCH = "__new__";
const date = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" })
    : "";
const unitWord = (r: Pick<InventoryRow, "sold_by_weight">, n: number) =>
  r.sold_by_weight ? "g" : n === 1 ? "unit" : "units";

function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {text}
    </p>
  );
}

function Preview({ label, before, after }: { label: string; before: number; after: number }) {
  const delta = after - before;
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold" data-testid="stock-preview">
        {before} → <span className="text-base">{after}</span>{" "}
        <span className={delta < 0 ? "text-destructive" : "text-primary"}>
          ({delta > 0 ? "+" : ""}
          {delta})
        </span>
      </span>
    </div>
  );
}

/** Searchable product picker for "Receive delivery" opened from the toolbar. */
function ProductPicker({
  rows,
  value,
  onChange,
}: {
  rows: InventoryRow[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = rows.find((r) => r.product_id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Product"
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{chosen ? chosen.name : "Search for a product…"}</span>
          <ChevronsUpDown size={14} className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Name, SKU or brand…" />
          <CommandList>
            <CommandEmpty>No product found.</CommandEmpty>
            <CommandGroup>
              {rows.map((r) => (
                <CommandItem
                  key={r.product_id}
                  value={`${r.name} ${r.sku ?? ""} ${r.brand ?? ""}`}
                  onSelect={() => {
                    onChange(r.product_id);
                    setOpen(false);
                  }}
                >
                  <Check
                    size={14}
                    className={r.product_id === value ? "opacity-100" : "opacity-0"}
                  />
                  <span className="truncate">{r.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {r.available} avail.
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function useBatches(api: InventoryApi, productId: string | null, open: boolean) {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBatches(null);
    setError(null);
    if (!open || !productId) return;
    let live = true;
    api
      .batches(productId)
      .then((b) => live && setBatches(b))
      .catch((e) => live && setError(errMsg(e)));
    return () => {
      live = false;
    };
  }, [api, productId, open]);
  return { batches, error };
}

/** Receive a delivery: product, batch (new or top-up), quantity with quick amounts, optional expiry and cost. */
export function ReceiveDialog({
  open,
  onOpenChange,
  row,
  rows,
  api,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  row: InventoryRow | null;
  rows: InventoryRow[];
  api: InventoryApi;
  onDone: (message: string) => Promise<void> | void;
}) {
  const [productId, setProductId] = useState(row?.product_id ?? "");
  const product = rows.find((r) => r.product_id === productId) ?? row ?? null;
  const { batches, error: batchError } = useBatches(api, productId || null, open);
  const [batch, setBatch] = useState(NEW_BATCH);
  const [code, setCode] = useState("");
  const [qty, setQty] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(createKeyStore());

  useEffect(() => {
    if (!open) return;
    setProductId(row?.product_id ?? "");
    setQty("");
    setExpiry("");
    setCost("");
    setNotes("");
    setError(null);
    keys.current.reset();
  }, [open, row?.product_id]);
  useEffect(() => {
    setBatch(NEW_BATCH);
    setCode(product ? suggestBatchCode(product) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, open]);

  const n = qty === "" ? 0 : Number(qty);
  const existing = batches?.find((b) => b.id === batch) ?? null;
  const costCents = cost.trim() === "" ? null : parseCents(cost);
  const problem = !product
    ? "Choose a product."
    : n < 1
      ? "Enter how many arrived."
      : !existing && code.trim().length === 0
        ? "Enter a batch code."
        : cost.trim() !== "" && costCents === null
          ? "Cost must be a rand amount, e.g. 45.50."
          : null;

  const submit = async () => {
    if (problem || !product) return;
    setBusy(true);
    setError(null);
    const body = {
      productId: product.product_id,
      batchCode: existing ? existing.batch_code : code.trim(),
      quantity: n,
      expiresAt: existing || !expiry ? null : new Date(`${expiry}T23:59:59`).toISOString(),
      unitCost: existing || costCents === null ? null : centsToAmount(costCents),
      notes: existing || !notes.trim() ? null : notes.trim(),
    };
    try {
      await api.receive({ ...body, key: keys.current.keyFor(JSON.stringify(body)) });
      keys.current.reset();
      onOpenChange(false);
      await onDone(
        `Received ${n} ${unitWord(product, n)} of ${product.name} into batch ${body.batchCode}.`,
      );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackagePlus size={18} /> Receive stock
          </DialogTitle>
          <DialogDescription>
            {product ? product.name : "Record a delivery. Earliest-expiry stock is sold first."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {!row && (
            <div className="grid gap-1.5">
              <Label>Product</Label>
              <ProductPicker
                rows={rows.filter((r) => r.track_stock)}
                value={productId}
                onChange={setProductId}
              />
            </div>
          )}
          {product && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="rcv-batch">Batch</Label>
                <Select value={batch} onValueChange={setBatch}>
                  <SelectTrigger id="rcv-batch">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NEW_BATCH}>New batch (new delivery)</SelectItem>
                    {(batches ?? []).map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        Top up {b.batch_code} · {b.qty_on_hand} on hand
                        {b.expires_at ? ` · exp ${date(b.expires_at)}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {batchError && <p className="text-xs text-destructive">{batchError}</p>}
              </div>
              {!existing && (
                <div className="grid gap-1.5">
                  <Label htmlFor="rcv-code">Batch code</Label>
                  <Input id="rcv-code" value={code} onChange={(e) => setCode(e.target.value)} />
                  <p className="text-[0.68rem] text-muted-foreground">
                    Suggested from the SKU and today's date. Use the supplier's code if there is
                    one.
                  </p>
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="rcv-qty">
                  Quantity received {product.sold_by_weight ? "(grams)" : ""}
                </Label>
                <QuantityStepper
                  id="rcv-qty"
                  label="quantity"
                  value={qty}
                  onChange={setQty}
                  quick={[1, 5, 10, 25, 50]}
                />
              </div>
              {!existing && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="rcv-expiry">Expiry date (optional)</Label>
                    <Input
                      id="rcv-expiry"
                      type="date"
                      value={expiry}
                      onChange={(e) => setExpiry(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="rcv-cost">Unit cost R (optional)</Label>
                    <Input
                      id="rcv-cost"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={cost}
                      onChange={(e) => setCost(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label htmlFor="rcv-notes">Notes (optional)</Label>
                    <Textarea
                      id="rcv-notes"
                      rows={2}
                      placeholder="Supplier, invoice number…"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </div>
                </div>
              )}
              <Preview
                label="Available after"
                before={product.available}
                after={product.available + n}
              />
            </>
          )}
          <Problem text={error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!!problem || busy}
            onClick={() => void submit()}
            title={problem ?? undefined}
          >
            {busy
              ? "Saving…"
              : n > 0 && product
                ? `Receive ${n} ${unitWord(product, n)}`
                : "Receive stock"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const DEFAULT_REASON: Record<AdjustMode, AdjustReason> = {
  remove: "damaged",
  add: "found",
  count: "count",
};

/** Correct stock: remove, add or set to the counted amount, with a reason picked from a list. */
export function AdjustDialog({
  open,
  onOpenChange,
  row,
  api,
  onDone,
  onReceiveInstead,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  row: InventoryRow | null;
  api: InventoryApi;
  onDone: (message: string) => Promise<void> | void;
  onReceiveInstead: () => void;
}) {
  const { batches, error: batchError } = useBatches(api, row?.product_id ?? null, open);
  const [batchId, setBatchId] = useState("");
  const [mode, setMode] = useState<AdjustMode>("count");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<AdjustReason>("count");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(createKeyStore());

  useEffect(() => {
    if (!open) return;
    setMode("count");
    setReason("count");
    setAmount("");
    setNote("");
    setError(null);
    keys.current.reset();
  }, [open, row?.product_id]);
  useEffect(() => {
    // One batch (the usual case) is picked for the user.
    setBatchId(batches && batches.length >= 1 ? batches[0]!.id : "");
  }, [batches]);

  const batch = batches?.find((b) => b.id === batchId) ?? null;
  const preview = useMemo(
    () =>
      batch && amount !== ""
        ? adjustmentPreview({
            mode,
            amount: Number(amount),
            batchOnHand: batch.qty_on_hand,
            batchHeld: batch.qty_held,
          })
        : null,
    [batch, amount, mode],
  );
  const reasonText = adjustmentReasonText(reason, note);
  const problem = !batch
    ? "Choose a batch."
    : amount === ""
      ? mode === "count"
        ? "Enter how many you counted."
        : "Enter a quantity."
      : preview?.problem
        ? preview.problem
        : !reasonText
          ? "Explain the reason (at least 3 characters)."
          : null;

  const submit = async () => {
    if (problem || !batch || !preview || !reasonText || !row) return;
    setBusy(true);
    setError(null);
    const body = { batchId: batch.id, delta: preview.delta, reason: reasonText };
    try {
      const r = await api.adjust({ ...body, key: keys.current.keyFor(JSON.stringify(body)) });
      keys.current.reset();
      onOpenChange(false);
      await onDone(
        `${row.name}, batch ${batch.batch_code}: ${r.before} → ${r.after}. Recorded in the audit log.`,
      );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal size={18} /> Adjust stock
          </DialogTitle>
          <DialogDescription>{row?.name}</DialogDescription>
        </DialogHeader>
        {batches && batches.length === 0 ? (
          <div className="grid gap-3 text-sm">
            <p>This product has no stock batches yet. Receive a delivery first.</p>
            <div>
              <Button onClick={onReceiveInstead}>
                <PackagePlus size={14} /> Receive stock
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>What do you want to do?</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                value={mode}
                onValueChange={(v) => {
                  if (!v) return;
                  setMode(v as AdjustMode);
                  setReason(DEFAULT_REASON[v as AdjustMode]);
                }}
                className="grid grid-cols-3"
              >
                <ToggleGroupItem value="count">Set counted amount</ToggleGroupItem>
                <ToggleGroupItem value="remove">Remove</ToggleGroupItem>
                <ToggleGroupItem value="add">Add</ToggleGroupItem>
              </ToggleGroup>
            </div>
            {batches && batches.length > 1 && (
              <div className="grid gap-1.5">
                <Label htmlFor="adj-batch">Batch</Label>
                <Select value={batchId} onValueChange={setBatchId}>
                  <SelectTrigger id="adj-batch">
                    <SelectValue placeholder="Choose a batch" />
                  </SelectTrigger>
                  <SelectContent>
                    {batches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.batch_code} · {b.qty_on_hand} on hand · {b.qty_held} held
                        {b.expires_at ? ` · exp ${date(b.expires_at)}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {batch && batches && batches.length === 1 && (
              <p className="text-xs text-muted-foreground">
                Batch {batch.batch_code}: {batch.qty_on_hand} on hand, {batch.qty_held} held for
                online orders.
              </p>
            )}
            {batchError && <p className="text-xs text-destructive">{batchError}</p>}
            <div className="grid gap-1.5">
              <Label htmlFor="adj-qty">
                {mode === "count"
                  ? "How many did you count?"
                  : mode === "remove"
                    ? "How many to remove?"
                    : "How many to add?"}
              </Label>
              <QuantityStepper id="adj-qty" label="quantity" value={amount} onChange={setAmount} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="adj-reason">Reason</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as AdjustReason)}>
                <SelectTrigger id="adj-reason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADJUST_REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="adj-note">
                Note {reason === "other" ? "(required)" : "(optional)"}
              </Label>
              <Textarea
                id="adj-note"
                rows={2}
                value={note}
                maxLength={250}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            {batch && preview && (
              <Preview
                label={`Batch ${batch.batch_code}`}
                before={batch.qty_on_hand}
                after={preview.after}
              />
            )}
            {amount !== "" && problem && <Problem text={problem} />}
            <Problem text={error} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!(batches && batches.length === 0) && (
            <Button
              disabled={!!problem || busy}
              onClick={() => void submit()}
              title={problem ?? undefined}
            >
              {busy ? "Saving…" : "Save adjustment"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The latest stock movements for one product. */
export function HistoryDialog({
  open,
  onOpenChange,
  row,
  api,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  row: InventoryRow | null;
  api: InventoryApi;
}) {
  const [items, setItems] = useState<StockMovement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setItems(null);
    setError(null);
    if (!open || !row) return;
    let live = true;
    api
      .history(row.product_id)
      .then((h) => live && setItems(h))
      .catch((e) => live && setError(errMsg(e)));
    return () => {
      live = false;
    };
  }, [api, open, row]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Stock history</DialogTitle>
          <DialogDescription>{row?.name} · latest 50 movements</DialogDescription>
        </DialogHeader>
        <Problem text={error} />
        {!items && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {items && items.length === 0 && (
          <p className="text-sm text-muted-foreground">No stock movements yet.</p>
        )}
        {items && items.length > 0 && (
          <ul className="divide-y divide-border text-sm">
            {items.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {MOVEMENT_LABEL[m.movement_type] ?? m.movement_type}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {new Date(m.created_at).toLocaleString("en-ZA", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {m.batch_code ? ` · ${m.batch_code}` : ""}
                    {m.actor_name ? ` · ${m.actor_name}` : ""}
                    {m.movement_type === "adjustment" ? ` · ${m.reason}` : ""}
                  </p>
                </div>
                <span
                  className={`shrink-0 font-bold ${m.quantity_delta < 0 ? "text-destructive" : "text-primary"}`}
                >
                  {m.quantity_delta > 0 ? "+" : ""}
                  {m.quantity_delta}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Set when a product counts as low stock (this tab and the daily low-stock email). */
export function ThresholdDialog({
  open,
  onOpenChange,
  row,
  api,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  row: InventoryRow | null;
  api: InventoryApi;
  onDone: (message: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open && row) {
      setValue(String(row.low_stock_threshold));
      setError(null);
    }
  }, [open, row]);
  const save = async () => {
    if (!row || value === "") return;
    setBusy(true);
    setError(null);
    try {
      await api.setThreshold(row.product_id, Number(value));
      onOpenChange(false);
      await onDone(`${row.name} now counts as low stock at ${value} or fewer.`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Low-stock alert</DialogTitle>
          <DialogDescription>
            {row?.name}: flag it as low stock (and include it in the daily low-stock email) when
            this many or fewer are available.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <QuantityStepper id="thr-qty" label="alert level" value={value} onChange={setValue} />
          <div className="flex flex-wrap gap-1.5">
            {[0, 3, 5, 10, 20, 50].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setValue(String(p))}
                className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${value === String(p) ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}
              >
                {p === 0 ? "Off" : p}
              </button>
            ))}
          </div>
          <Problem text={error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || value === ""} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
