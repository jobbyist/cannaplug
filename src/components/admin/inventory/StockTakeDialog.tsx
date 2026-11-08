import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, ClipboardList, Download, FileUp, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createKeyStore } from "@/components/admin/pos/pos-logic";
import { rand } from "@/lib/cart";
import type { InventoryRow } from "@/lib/inventory-logic";
import {
  countCsv,
  countSheetCsv,
  countableProducts,
  findProducts,
  planCountUpload,
  varianceSummary,
  type CountUploadPlan,
} from "@/lib/stock-take-logic";
import type { StockOpsApi, StockTakeView } from "./inventory-api";

const errorText = (e: unknown) =>
  e instanceof Error && e.message ? e.message : "That didn't work and nothing was changed.";
const key = () => crypto.randomUUID();

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });

/**
 * Stock take. A manager starts a count (all products or one category). Anyone on staff counts: scan or search a
 * product, type what is on the shelf, save. Counting is "blind" (the system number is not shown while counting) so
 * it is a real count. A manager then reviews the differences and posts them all at once, or cancels.
 */
export function StockTakeDialog({
  open,
  onOpenChange,
  rows,
  categories,
  canManage,
  api,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rows: InventoryRow[];
  categories: string[];
  canManage: boolean;
  api: StockOpsApi;
  onDone: (message: string) => Promise<void> | void;
}) {
  const [view, setView] = useState<StockTakeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<"count" | "review">("count");

  const load = useCallback(async () => {
    try {
      setView(await api.getStockTake());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);
  useEffect(() => {
    if (!open) return;
    setStage("count");
    void load();
  }, [open, load]);

  const take = view?.take ?? null;
  const isOpen = take?.status === "open";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList size={18} /> Stock take
          </DialogTitle>
          <DialogDescription>
            {isOpen
              ? `Counting ${take.category ? take.category : "all products"}${take.note ? ` · ${take.note}` : ""}`
              : "Count what is on the shelf and correct the system in one go."}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {!view && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {view && !isOpen && (
          <StartCount
            canManage={canManage}
            categories={categories}
            last={take}
            busy={busy}
            onStart={async (category, note) => {
              setBusy(true);
              setError(null);
              try {
                await api.startStockTake({ category, note, key: key() });
                await load();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
        {view && isOpen && stage === "count" && (
          <CountStage
            rows={rows}
            view={view}
            api={api}
            canManage={canManage}
            onSaved={load}
            onReview={() => setStage("review")}
          />
        )}
        {view && isOpen && stage === "review" && canManage && (
          <ReviewStage
            view={view}
            uncounted={countableProducts(rows, take.category).length - view.lines.length}
            busy={busy}
            onBack={() => setStage("count")}
            onPost={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await api.postStockTake({ stockTakeId: take.id, key: key() });
                onOpenChange(false);
                await onDone(
                  `Count posted: ${r.changed} of ${r.lines} products corrected (+${r.units_added} / −${r.units_removed}).`,
                );
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
            onCancel={async () => {
              if (
                !window.confirm("Cancel this count? Nothing counted so far will change the stock.")
              )
                return;
              setBusy(true);
              try {
                await api.cancelStockTake({ stockTakeId: take.id, key: key() });
                onOpenChange(false);
                await onDone("Count cancelled. Stock was not changed.");
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function StartCount({
  canManage,
  categories,
  last,
  busy,
  onStart,
}: {
  canManage: boolean;
  categories: string[];
  last: StockTakeView["take"];
  busy: boolean;
  onStart: (category: string | null, note: string | null) => Promise<void>;
}) {
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  return (
    <div className="grid gap-4">
      {last && (
        <p className="text-sm text-muted-foreground">
          Last count: {last.status === "posted" ? "posted" : "cancelled"}{" "}
          {last.closed_at ? new Date(last.closed_at).toLocaleString("en-ZA") : ""}.
        </p>
      )}
      {canManage ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="st-category">What are you counting?</Label>
            <select
              id="st-category"
              className="h-11 rounded-md border border-input bg-background px-3 text-base md:text-sm"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All products</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c} only
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="st-note">Note (optional)</Label>
            <Input
              id="st-note"
              className="h-11"
              maxLength={300}
              placeholder="e.g. Month-end count"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <Button
            size="lg"
            disabled={busy}
            onClick={() => void onStart(category || null, note.trim() || null)}
          >
            {busy ? "Starting…" : "Start counting"}
          </Button>
        </>
      ) : (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">
          No count is open. Ask a manager to start one, then you can count from here.
        </p>
      )}
    </div>
  );
}

function CountStage({
  rows,
  view,
  api,
  canManage,
  onSaved,
  onReview,
}: {
  rows: InventoryRow[];
  view: StockTakeView;
  api: StockOpsApi;
  canManage: boolean;
  onSaved: () => Promise<void>;
  onReview: () => void;
}) {
  const take = view.take!;
  const scope = useMemo(() => countableProducts(rows, take.category), [rows, take.category]);
  const counted = useMemo(() => new Map(view.lines.map((l) => [l.product_id, l])), [view.lines]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<InventoryRow | null>(null);
  const [qty, setQty] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef(createKeyStore());
  const qtyRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => findProducts(scope, query), [scope, query]);
  const next = useMemo(
    () => scope.filter((r) => !counted.has(r.product_id)).slice(0, 12),
    [scope, counted],
  );

  const pick = (r: InventoryRow) => {
    setPicked(r);
    setQuery("");
    setQty(counted.has(r.product_id) ? String(counted.get(r.product_id)!.counted) : "");
    setError(null);
    window.setTimeout(() => qtyRef.current?.focus(), 30);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!picked) return;
    const n = Number(qty);
    if (qty === "" || !Number.isInteger(n) || n < 0)
      return setError("Enter the number you counted (0 if none).");
    setBusy(true);
    setError(null);
    try {
      await api.recordCount({
        stockTakeId: take.id,
        productId: picked.product_id,
        counted: n,
        key: keys.current.keyFor(JSON.stringify([take.id, picked.product_id, n])),
      });
      keys.current.reset();
      setSaved(`${picked.name}: ${n} saved.`);
      setPicked(null);
      setQty("");
      await onSaved();
      window.setTimeout(() => searchRef.current?.focus(), 30);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold" data-testid="count-progress">
          {view.lines.length} of {scope.length} counted
        </p>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className="h-full bg-primary"
            style={{
              width: `${scope.length ? Math.min(100, (view.lines.length / scope.length) * 100) : 0}%`,
            }}
          />
        </div>
      </div>
      {saved && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-sm text-primary"
        >
          <CheckCircle2 size={16} /> {saved}
        </p>
      )}
      {!picked ? (
        <div className="grid gap-1.5">
          <Label htmlFor="st-scan">Scan a barcode or search a product</Label>
          <div className="relative">
            <ScanLine
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="st-scan"
              ref={searchRef}
              className="h-12 pl-9 text-base"
              autoComplete="off"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (matches.length >= 1) pick(matches[0]!);
                }
              }}
            />
          </div>
          <ul
            className="grid max-h-64 gap-1 overflow-y-auto"
            aria-label={query.trim() ? "Matching products" : "Still to count"}
          >
            {(query.trim() ? matches : next).map((r) => (
              <li key={r.product_id}>
                <button
                  type="button"
                  onClick={() => pick(r)}
                  className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-border px-3 text-left text-sm hover:bg-muted"
                >
                  <span className="truncate">{r.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {counted.has(r.product_id)
                      ? `counted ${counted.get(r.product_id)!.counted}`
                      : r.category}
                  </span>
                </button>
              </li>
            ))}
            {query.trim() && matches.length === 0 && (
              <li className="px-2 py-2 text-sm text-muted-foreground">
                No product in this count matches.
              </li>
            )}
          </ul>
        </div>
      ) : (
        <form
          onSubmit={(e) => void save(e)}
          className="grid gap-3 rounded-lg border border-border p-4"
        >
          <p className="font-semibold">{picked.name}</p>
          <div className="grid gap-1.5">
            <Label htmlFor="st-qty">
              How many are on the shelf{picked.sold_by_weight ? " (grams)" : ""}?
            </Label>
            <Input
              id="st-qty"
              ref={qtyRef}
              inputMode="numeric"
              className="h-14 text-2xl font-bold"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="lg" onClick={() => setPicked(null)}>
              Back
            </Button>
            <Button type="submit" size="lg" className="flex-1" disabled={busy}>
              {busy ? "Saving…" : "Save count"}
            </Button>
          </div>
        </form>
      )}
      {!picked && (
        <CountSheetUpload
          scope={scope}
          view={view}
          api={api}
          onSaved={async (message) => {
            setSaved(message);
            await onSaved();
          }}
        />
      )}
      {canManage && (
        <Button variant="secondary" size="lg" disabled={view.lines.length === 0} onClick={onReview}>
          Review differences ({view.lines.length} counted)
        </Button>
      )}
    </div>
  );
}

/**
 * Count on paper or in a spreadsheet instead of product by product: download the count sheet, fill in the "counted"
 * column, upload it. The file is checked first (what will be saved, rows that don't match, rows left blank) and
 * nothing is saved until "Save counts" is pressed. Each row then saves exactly like a count typed on screen.
 */
function CountSheetUpload({
  scope,
  view,
  api,
  onSaved,
}: {
  scope: InventoryRow[];
  view: StockTakeView;
  api: StockOpsApi;
  onSaved: (message: string) => Promise<void>;
}) {
  const take = view.take!;
  const [plan, setPlan] = useState<CountUploadPlan | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ name: string; problem: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadKey = useRef<string | null>(null);

  const reset = () => {
    setPlan(null);
    setFileName("");
    setError(null);
    uploadKey.current = null;
    if (fileRef.current) fileRef.current.value = "";
  };
  const pick = async (file: File) => {
    reset();
    setFailed([]);
    if (file.size > 2_000_000) return setError("That file is bigger than 2 MB.");
    try {
      const text = await file.text();
      const already = new Map(view.lines.map((l) => [l.product_id, l.counted]));
      setPlan(planCountUpload(text, scope, already));
      setFileName(file.name);
    } catch {
      setError("Could not read that file. Save it as CSV and try again.");
    }
  };
  const save = async () => {
    if (!plan?.lines.length) return;
    setBusy(true);
    setError(null);
    uploadKey.current ??= key();
    try {
      const r = await api.recordCounts({
        stockTakeId: take.id,
        lines: plan.lines.map((l) => ({ productId: l.product_id, counted: l.counted })),
        key: uploadKey.current,
      });
      const names = new Map(plan.lines.map((l) => [l.product_id, l.name]));
      setFailed(r.failed.map((f) => ({ name: names.get(f.productId) ?? "", problem: f.problem })));
      reset();
      await onSaved(
        `Count sheet saved: ${r.saved} product${r.saved === 1 ? "" : "s"} counted` +
          (r.failed.length ? `, ${r.failed.length} not saved (see below).` : "."),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="grid gap-3 rounded-lg border border-dashed border-border p-3"
      data-testid="count-sheet"
    >
      <div>
        <p className="text-sm font-semibold">Counting on paper or in a spreadsheet?</p>
        <p className="text-xs text-muted-foreground">
          Download the count sheet, fill in the <b>counted</b> column (leave it blank for anything
          you didn&apos;t count), save as CSV and upload it here. You see what will be saved first.
        </p>
      </div>
      {!plan && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              downloadText(`cannaplug-count-sheet-${today()}.csv`, countSheetCsv(scope))
            }
          >
            <Download size={14} /> Download count sheet
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            aria-label="Count sheet CSV"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pick(f);
            }}
          />
          <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
            <FileUp size={14} /> Upload filled sheet
          </Button>
        </div>
      )}
      {plan && (
        <div className="grid gap-2 text-sm" data-testid="count-sheet-preview">
          <p className="text-xs text-muted-foreground">{fileName}</p>
          <ul className="grid grid-cols-2 gap-1 sm:grid-cols-4">
            <li>
              <b>{plan.lines.length}</b> to save
            </li>
            <li>
              <b>{plan.unchanged}</b> already saved
            </li>
            <li>
              <b>{plan.blank}</b> left blank
            </li>
            <li className={plan.issues.length ? "text-destructive" : ""}>
              <b>{plan.issues.length}</b> problem rows
            </li>
          </ul>
          {plan.issues.length > 0 && (
            <div className="rounded-md border border-destructive/40 p-2">
              <p className="mb-1 font-semibold text-destructive">
                These rows will not be saved. Fix them in the file and upload it again, or count
                them on screen:
              </p>
              <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-xs text-destructive">
                {plan.issues.map((i) => (
                  <li key={`${i.line}-${i.problem}`}>
                    Line {i.line}
                    {i.label ? ` (${i.label})` : ""}: {i.problem}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.lines.length > 0 && (
            <div className="max-h-48 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 font-medium">Product</th>
                    <th className="py-1 text-right font-medium">Counted</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.lines.map((l) => (
                    <tr key={l.product_id} className="border-t border-border">
                      <td className="py-1 pr-2">
                        {l.name}
                        {l.previous != null && (
                          <span className="text-muted-foreground"> (was counted {l.previous})</span>
                        )}
                      </td>
                      <td className="py-1 text-right font-semibold">{l.counted}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {plan.lines.length === 0 && plan.issues.length === 0 && (
            <p className="rounded-md bg-muted px-3 py-2">
              Nothing new to save: fill in the counted column and upload again.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy || plan.lines.length === 0}
              onClick={() => void save()}
            >
              {busy
                ? "Saving…"
                : `Save ${plan.lines.length} count${plan.lines.length === 1 ? "" : "s"}`}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={reset}>
              Choose another file
            </Button>
          </div>
        </div>
      )}
      {failed.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-xs text-destructive">
          {failed.map((f) => (
            <li key={f.name + f.problem}>
              {f.name}: {f.problem}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function ReviewStage({
  view,
  uncounted,
  busy,
  onBack,
  onPost,
  onCancel,
}: {
  view: StockTakeView;
  uncounted: number;
  busy: boolean;
  onBack: () => void;
  onPost: () => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const s = varianceSummary(view.lines);
  const changed = view.lines
    .filter((l) => l.difference !== 0)
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  const download = () => {
    const blob = new Blob([countCsv(view.lines)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cannaplug-stock-count-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="variance-summary">
        <Stat label="Counted" value={String(s.counted)} />
        <Stat label="To correct" value={String(s.changed)} />
        <Stat
          label="Short"
          value={`−${s.unitsUnder}`}
          hint={s.valueUnder != null ? rand(s.valueUnder) : undefined}
        />
        <Stat
          label="Over"
          value={`+${s.unitsOver}`}
          hint={s.valueOver != null ? rand(s.valueOver) : undefined}
        />
      </div>
      {uncounted > 0 && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {uncounted} product{uncounted === 1 ? " was" : "s were"} not counted. Their stock stays as
          it is.
        </p>
      )}
      {changed.length === 0 ? (
        <p className="text-sm text-muted-foreground">Everything counted matches the system.</p>
      ) : (
        <div className="-mx-1 max-h-72 overflow-auto px-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Product</th>
                <th className="py-1 pr-2 text-right font-medium">System</th>
                <th className="py-1 pr-2 text-right font-medium">Counted</th>
                <th className="py-1 text-right font-medium">Difference</th>
              </tr>
            </thead>
            <tbody>
              {changed.map((l) => (
                <tr key={l.product_id} className="border-t border-border">
                  <td className="py-2 pr-2">{l.name}</td>
                  <td className="py-2 pr-2 text-right">{l.expected}</td>
                  <td className="py-2 pr-2 text-right">{l.counted}</td>
                  <td
                    className={
                      "py-2 text-right font-semibold " +
                      (l.difference < 0 ? "text-destructive" : "text-primary")
                    }
                  >
                    {l.difference > 0 ? `+${l.difference}` : l.difference}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Differences are measured from what the system showed when each product was counted, so sales
        made since then are kept.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onBack}>
          Back to counting
        </Button>
        <Button variant="outline" onClick={download}>
          <Download size={14} /> Download count
        </Button>
        <Button
          variant="ghost"
          className="text-destructive"
          disabled={busy}
          onClick={() => void onCancel()}
        >
          Cancel count
        </Button>
        <Button size="lg" className="ml-auto" disabled={busy} onClick={() => void onPost()}>
          {busy ? "Posting…" : `Post count (${s.changed} correction${s.changed === 1 ? "" : "s"})`}
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-display text-lg font-extrabold">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
