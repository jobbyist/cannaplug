import { useEffect, useRef, useState } from "react";
import { Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adjustStockFn, listBatchesFn, receiveStockFn } from "@/lib/pos.functions";
import { centsToAmount, createKeyStore, parseCents, type CatalogItem } from "./pos-logic";
import { cleanQtyInput, formatQty, parseQty, roundQty } from "@/lib/qty";

const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";
const errorClass =
  "rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive";
const okClass = "rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-xs text-primary";
const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please retry.";

type Batch = {
  id: string;
  batch_code: string;
  qty_on_hand: number;
  qty_held: number;
  available: number;
  expires_at: string | null;
};

/** Manager-only stock receipts and audited manual adjustments. Stock is only ever changed by the database. */
export function StockControl({
  catalog,
  onChanged,
}: {
  catalog: CatalogItem[];
  onChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"receive" | "adjust">("receive");
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-sm font-bold uppercase">
          <Boxes size={14} className="mr-1 inline" /> Stock control
        </h2>
        <div className="flex gap-1 text-xs">
          {(["receive", "adjust"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-full px-3 py-1 font-semibold transition ${tab === t ? "bg-primary text-primary-foreground" : "border border-border hover:bg-muted"}`}
            >
              {t === "receive" ? "Receive stock" : "Adjust stock"}
            </button>
          ))}
        </div>
      </div>
      {tab === "receive" ? (
        <ReceiveForm catalog={catalog} onChanged={onChanged} />
      ) : (
        <AdjustForm catalog={catalog} onChanged={onChanged} />
      )}
    </div>
  );
}

function ReceiveForm({
  catalog,
  onChanged,
}: {
  catalog: CatalogItem[];
  onChanged: () => Promise<void>;
}) {
  const [productId, setProductId] = useState("");
  const [batchCode, setBatchCode] = useState("");
  const [quantity, setQuantity] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const keys = useRef(createKeyStore());

  // Weighed products take one decimal (27.4 g); everything else is whole units.
  const decimals = Boolean(catalog.find((c) => c.id === productId)?.sold_by_weight);
  const qty = parseQty(quantity, { decimals, allowZero: false }) ?? 0;
  const costCents = cost.trim() === "" ? null : parseCents(cost);
  const valid =
    productId &&
    batchCode.trim().length > 0 &&
    qty > 0 &&
    (cost.trim() === "" || costCents !== null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    const body = {
      productId,
      batchCode: batchCode.trim(),
      quantity: qty,
      expiresAt: expiry ? new Date(`${expiry}T23:59:59`).toISOString() : null,
      unitCost: costCents === null ? null : centsToAmount(costCents),
      notes: null,
    };
    try {
      await receiveStockFn({ data: { ...body, key: keys.current.keyFor(JSON.stringify(body)) } });
      keys.current.reset();
      setDone(`Received ${qty} units into batch ${body.batchCode}.`);
      setQuantity("");
      await onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-semibold">
          Product
          <select
            className={selectClass}
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            <option value="">Select product…</option>
            {catalog.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.available} available)
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-semibold">
          Batch code
          <Input
            value={batchCode}
            onChange={(e) => setBatchCode(e.target.value)}
            placeholder="e.g. BG-0929"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold">
          Quantity received
          <Input
            inputMode={decimals ? "decimal" : "numeric"}
            value={quantity}
            onChange={(e) => setQuantity(cleanQtyInput(e.target.value))}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold">
          Expiry date (optional)
          <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold">
          Unit cost R (optional)
          <Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        </label>
      </div>
      <p className="text-[0.68rem] text-muted-foreground">
        Receiving into an existing batch code tops that batch up. Earliest-expiry stock is sold
        first.
      </p>
      {error && (
        <div className={errorClass} role="alert">
          {error}
        </div>
      )}
      {done && (
        <div className={okClass} role="status">
          {done}
        </div>
      )}
      <div>
        <Button size="sm" disabled={!valid || busy} onClick={() => void submit()}>
          Receive stock
        </Button>
      </div>
    </div>
  );
}

function AdjustForm({
  catalog,
  onChanged,
}: {
  catalog: CatalogItem[];
  onChanged: () => Promise<void>;
}) {
  const [productId, setProductId] = useState("");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState("");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const keys = useRef(createKeyStore());

  const loadBatches = async (pid: string) => {
    setBatchId("");
    setBatches([]);
    if (!pid) return;
    try {
      setBatches((await listBatchesFn({ data: { productId: pid } })) as Batch[]);
    } catch (e) {
      setError(errMsg(e));
    }
  };
  useEffect(() => {
    void loadBatches(productId);
  }, [productId]);

  const decimals = Boolean(catalog.find((c) => c.id === productId)?.sold_by_weight);
  const negative = delta.trim().startsWith("-");
  const parsed = parseQty(delta.replace(/^-/, ""), { decimals, allowZero: false });
  const n = parsed === null ? 0 : negative ? roundQty(-parsed) : parsed;
  const valid = batchId && n !== 0 && reason.trim().length >= 3;

  const submit = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    const body = { batchId, delta: n, reason: reason.trim() };
    try {
      const r = (await adjustStockFn({
        data: { ...body, key: keys.current.keyFor(JSON.stringify(body)) },
      })) as { before: number; after: number };
      keys.current.reset();
      setDone(
        `Adjusted: ${formatQty(Number(r.before))} → ${formatQty(Number(r.after))} ${decimals ? "g" : "units"}. Recorded in the audit log.`,
      );
      setDelta("");
      setReason("");
      await loadBatches(productId);
      await onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-semibold">
          Product
          <select
            className={selectClass}
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            <option value="">Select product…</option>
            {catalog.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-semibold">
          Batch
          <select
            className={selectClass}
            value={batchId}
            onChange={(e) => setBatchId(e.target.value)}
            disabled={batches.length === 0}
          >
            <option value="">
              {productId && batches.length === 0 ? "No batches" : "Select batch…"}
            </option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.batch_code} · {formatQty(b.qty_on_hand)} on hand · {formatQty(b.qty_held)} held ·{" "}
                {formatQty(b.available)} free
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-semibold">
          Change (+ add / − remove)
          <Input
            inputMode={decimals ? "decimal" : "numeric"}
            placeholder={decimals ? "-2.5" : "-2"}
            value={delta}
            onChange={(e) => {
              const minus = e.target.value.trim().startsWith("-") ? "-" : "";
              setDelta(minus + cleanQtyInput(e.target.value.replace(/-/g, "")));
            }}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold">
          Reason (required)
          <Input
            placeholder="e.g. damaged in storage"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </div>
      <p className="text-[0.68rem] text-muted-foreground">
        Stock can never go below zero or below quantities held for online orders. Every adjustment
        is written to the audit log with your name and reason.
      </p>
      {error && (
        <div className={errorClass} role="alert">
          {error}
        </div>
      )}
      {done && (
        <div className={okClass} role="status">
          {done}
        </div>
      )}
      <div>
        <Button size="sm" disabled={!valid || busy} onClick={() => void submit()}>
          Apply adjustment
        </Button>
      </div>
    </div>
  );
}
