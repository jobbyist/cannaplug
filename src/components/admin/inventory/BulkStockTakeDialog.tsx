import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileUp, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { InventoryRow } from "@/lib/inventory-logic";
import {
  countSheetCsv,
  countableProducts,
  planCountUpload,
  type CountUploadPlan,
} from "@/lib/stock-take-logic";
import type { StockOpsApi } from "./inventory-api";

const errorText = (e: unknown) =>
  e instanceof Error && e.message ? e.message : "That didn't work and nothing was changed.";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });
const NO_COUNTS = new Map<string, number>();

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

/**
 * Bulk stock take (managers): the whole count from one spreadsheet. Download the count sheet, fill in "counted",
 * upload it, check the preview, then one button starts the stock take and saves every count. The manager lands on
 * the usual review screen to post (or cancel). It uses the same database functions as a count done on screen, so
 * nothing about posting, held stock or sales made during the count changes.
 */
export function BulkStockTakeDialog({
  open,
  onOpenChange,
  rows,
  categories,
  api,
  onLoaded,
  onOpenCurrent,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rows: InventoryRow[];
  categories: string[];
  api: StockOpsApi;
  /** Counts are saved: show the review screen of the new stock take. */
  onLoaded: (message: string) => void;
  /** A stock take is already open: go to it instead. */
  onOpenCurrent: () => void;
}) {
  const [checking, setChecking] = useState(true);
  const [alreadyOpen, setAlreadyOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [plan, setPlan] = useState<CountUploadPlan | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const keys = useRef<{ start: string; counts: string } | null>(null);

  const scope = useMemo(() => countableProducts(rows, category || null), [rows, category]);

  const resetFile = () => {
    setPlan(null);
    setFileName("");
    keys.current = null;
    if (fileRef.current) fileRef.current.value = "";
  };
  useEffect(() => {
    if (!open) return;
    setCategory("");
    setError(null);
    resetFile();
    setChecking(true);
    let alive = true;
    api
      .getStockTake()
      .then((v) => alive && setAlreadyOpen(v.take?.status === "open"))
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setChecking(false));
    return () => {
      alive = false;
    };
  }, [open, api]);

  const pick = async (file: File) => {
    resetFile();
    setError(null);
    if (file.size > 2_000_000) return setError("That file is bigger than 2 MB.");
    try {
      setPlan(planCountUpload(await file.text(), scope, NO_COUNTS));
      setFileName(file.name);
    } catch {
      setError("Could not read that file. Save it as CSV and try again.");
    }
  };

  const load = async () => {
    if (!plan?.lines.length) return;
    setBusy(true);
    setError(null);
    keys.current ??= { start: crypto.randomUUID(), counts: crypto.randomUUID() };
    let started = false;
    try {
      const r = (await api.startStockTake({
        category: category || null,
        note: `Bulk CSV upload: ${fileName}`.slice(0, 300),
        key: keys.current.start,
      })) as { stock_take_id?: string } | null;
      started = true;
      const id = r?.stock_take_id ?? (await api.getStockTake()).take?.id;
      if (!id) throw new Error("The stock take started but could not be found. Open Stock take.");
      const saved = await api.recordCounts({
        stockTakeId: id,
        lines: plan.lines.map((l) => ({ productId: l.product_id, counted: l.counted })),
        key: keys.current.counts,
      });
      onLoaded(
        `Bulk stock take loaded: ${saved.saved} product${saved.saved === 1 ? "" : "s"} counted` +
          (saved.failed.length ? `, ${saved.failed.length} could not be saved` : "") +
          ". Check the differences, then post.",
      );
    } catch (e) {
      setError(
        started
          ? `${errorText(e)} The stock take is open: open Stock take to finish or cancel it.`
          : errorText(e),
      );
      if (started) setAlreadyOpen(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload size={18} /> Bulk stock take (CSV)
          </DialogTitle>
          <DialogDescription>
            Count everything in one spreadsheet and upload it. You check the differences before any
            stock changes.
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
        {checking ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : alreadyOpen ? (
          <div className="grid gap-3">
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              A stock take is already open. Finish or cancel it first, or upload your sheet into it
              from the Stock take window.
            </p>
            <Button size="lg" onClick={onOpenCurrent}>
              Open the current stock take
            </Button>
          </div>
        ) : (
          <div className="grid gap-4">
            <ol className="grid list-decimal gap-1 pl-5 text-sm text-muted-foreground">
              <li>Choose what you are counting and download the count sheet.</li>
              <li>
                Fill in the <b>counted</b> column (grams for weighed products, 0 if none, blank if
                not counted) and save it as CSV.
              </li>
              <li>Upload it, check the preview, and load the counts.</li>
            </ol>
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-category">What are you counting?</Label>
              <select
                id="bulk-category"
                className="h-11 rounded-md border border-input bg-background px-3 text-base md:text-sm"
                value={category}
                disabled={busy}
                onChange={(e) => {
                  setCategory(e.target.value);
                  resetFile();
                }}
              >
                <option value="">All products ({countableProducts(rows, null).length})</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c} only ({countableProducts(rows, c).length})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy || scope.length === 0}
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
                aria-label="Bulk count CSV"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pick(f);
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                <FileUp size={14} /> Upload filled sheet
              </Button>
            </div>
            {plan && (
              <div className="grid gap-2 text-sm" data-testid="bulk-preview">
                <p className="text-xs text-muted-foreground">{fileName}</p>
                <ul className="grid grid-cols-3 gap-1">
                  <li>
                    <b>{plan.lines.length}</b> counted
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
                      These rows will not be loaded. Fix them and upload again, or count them on
                      screen afterwards:
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
                {plan.lines.length === 0 && plan.issues.length === 0 && (
                  <p className="rounded-md bg-muted px-3 py-2">
                    No counts in this file: fill in the counted column and upload again.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Products left blank are not counted and keep their stock. Nothing changes until
                  you post the stock take on the next screen.
                </p>
                <Button
                  size="lg"
                  disabled={busy || plan.lines.length === 0}
                  onClick={() => void load()}
                >
                  {busy
                    ? "Loading counts…"
                    : `Start stock take and load ${plan.lines.length} count${plan.lines.length === 1 ? "" : "s"}`}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
