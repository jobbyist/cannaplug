import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { commitCatalogueImportFn, previewCatalogueImportFn } from "@/lib/catalogue.functions";
import { rand } from "@/lib/cart";

type Preview = Awaited<ReturnType<typeof previewCatalogueImportFn>>;
type Result = Awaited<ReturnType<typeof commitCatalogueImportFn>>;

/** /admin → Products → Import from Yoco: upload, dry run, confirm. Nothing is written before Confirm. */
export function CatalogueImport({ onImported }: { onImported: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [deactivate, setDeactivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setCsv(null);
    setPreview(null);
    setResult(null);
    setError(null);
  };

  const pick = async (file: File) => {
    reset();
    setBusy(true);
    try {
      const text = await file.text();
      setCsv(text);
      setPreview(await previewCatalogueImportFn({ data: { csv: text } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!csv) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await commitCatalogueImportFn({
          data: { csv, deactivateMissing: deactivate, key: crypto.randomUUID() },
        }),
      );
      await onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import failed. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  const s = preview?.summary;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Upload size={14} /> Import from Yoco
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import products from Yoco</DialogTitle>
            <DialogDescription>
              Upload the product export (CSV) from the Yoco Business Portal. You will see exactly
              what changes before anything is saved.
            </DialogDescription>
          </DialogHeader>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            aria-label="Yoco product export"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pick(f);
            }}
          />
          {!preview && !result && (
            <Button disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? "Reading…" : "Choose CSV file"}
            </Button>
          )}
          {preview && s && !result && (
            <div className="space-y-3 text-sm" data-testid="import-preview">
              {preview.alreadyImportedAt && (
                <p className="rounded-md bg-secondary p-2">
                  This exact file was already imported on{" "}
                  {new Date(preview.alreadyImportedAt).toLocaleString("en-ZA")}. Importing again
                  changes nothing.
                </p>
              )}
              <ul className="grid grid-cols-2 gap-2">
                <li>
                  <b>{s.products}</b> products ({preview.creates} new, {preview.updates} updated)
                </li>
                <li>
                  <b>{s.stocked}</b> with opening stock ({s.openingUnits} units,{" "}
                  {rand(s.openingRetailValue)} at retail)
                </li>
                <li>
                  <b>{s.weighed}</b> sold by the gram
                </li>
                <li>
                  <b>{s.inStoreOnly}</b> in-store only (Lounge)
                </li>
                <li>
                  <b>{preview.priceChanges}</b> price changes
                </li>
                <li>
                  <b>{s.issues}</b> problem rows
                </li>
              </ul>
              <p className="text-xs text-muted-foreground">
                {Object.entries(s.byCategory)
                  .map(([c, n]) => `${c} ${n}`)
                  .join(" · ")}
              </p>
              {preview.notes.length > 0 && (
                <ul className="list-disc pl-5 text-xs">
                  {preview.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              {preview.issues.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-destructive">
                  {preview.issues.map((i) => (
                    <li key={`${i.line}-${i.problem}`}>
                      Line {i.line} {i.name}: {i.problem}
                    </li>
                  ))}
                </ul>
              )}
              {preview.wouldDeactivate.length > 0 && (
                <label className="flex items-start gap-2 rounded-md border border-border p-2">
                  <input
                    type="checkbox"
                    checked={deactivate}
                    onChange={(e) => setDeactivate(e.target.checked)}
                  />
                  <span>
                    Switch off the {preview.wouldDeactivate.length} products that are not in this
                    file (they stay in history and can be switched back on).
                  </span>
                </label>
              )}
              <div className="flex gap-2">
                <Button disabled={busy || preview.issues.length > 0} onClick={() => void confirm()}>
                  {busy ? "Importing…" : "Confirm import"}
                </Button>
                <Button variant="outline" onClick={reset}>
                  Choose another file
                </Button>
              </div>
            </div>
          )}
          {result && (
            <div role="status" className="space-y-1 text-sm">
              <p className="font-semibold">
                {result.already_imported
                  ? "Already imported — nothing changed."
                  : "Import complete."}
              </p>
              <p>
                {result.created} created · {result.updated} updated · {result.stocked_products}{" "}
                stocked ({result.opening_units} units) · {result.deactivated} switched off
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
