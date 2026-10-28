import { useRef, useState } from "react";
import { Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  commitProductCsvFn,
  exportProductsCsvFn,
  previewProductCsvFn,
} from "@/lib/product-csv.functions";
import { productCsvTemplate } from "@/lib/product-csv";

type Preview = Awaited<ReturnType<typeof previewProductCsvFn>>;
type Result = Awaited<ReturnType<typeof commitProductCsvFn>>;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });

/** /admin → Products → CSV upload / edit: template or current products out, edited file in, dry run, confirm. */
export function ProductCsv({ onSaved }: { onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<null | "export" | "read" | "save">(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setCsv(null);
    setFileName("");
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const exportCurrent = async () => {
    setBusy("export");
    setError(null);
    try {
      const r = await exportProductsCsvFn();
      download(`cannaplug-products-${today()}.csv`, r.csv);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not download the products.");
    } finally {
      setBusy(null);
    }
  };

  const pick = async (file: File) => {
    reset();
    setBusy("read");
    try {
      const text = await file.text();
      setCsv(text);
      setFileName(file.name);
      setPreview(await previewProductCsvFn({ data: { csv: text } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!csv) return;
    setBusy("save");
    setError(null);
    try {
      setResult(await commitProductCsvFn({ data: { csv, key: crypto.randomUUID() } }));
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nothing was saved.");
    } finally {
      setBusy(null);
    }
  };

  const changes = preview ? preview.creates.length + preview.updates.length : 0;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <FileSpreadsheet size={14} /> CSV upload / edit
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Upload or edit products with a spreadsheet</DialogTitle>
            <DialogDescription>
              Download the template or your current products, edit them in Excel or Google Sheets,
              save as CSV and upload. You see every change before anything is saved.
            </DialogDescription>
          </DialogHeader>

          {!preview && !result && (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => download("cannaplug-product-template.csv", productCsvTemplate())}
                >
                  <Download size={14} /> Blank template
                </Button>
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void exportCurrent()}
                >
                  <Download size={14} />
                  {busy === "export" ? "Preparing…" : "Current products (to edit)"}
                </Button>
              </div>
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                <li>
                  <b>sku</b> identifies the product. A SKU that is not in the shop yet creates a new
                  product (it then needs name, category and price).
                </li>
                <li>
                  A <b>blank cell</b> leaves that field as it is. A single <b>-</b> clears an
                  optional field (sale price, sale end, cost, brand, barcode, unit, description).
                </li>
                <li>
                  <b>price</b> is the normal price in rand. A lower <b>sale_price</b> puts the
                  product on sale until <b>sale_ends</b> (a date like 2026-11-30, optional).
                </li>
                <li>
                  Yes/no columns: sold_by_weight, sell_online, featured, active. weight_step_g is 1
                  or 0.5. Categories: Flower, Pre-rolls, Edibles, Drinks, CBD, Vapes, Concentrates,
                  Accessories, Lounge.
                </li>
                <li>
                  <b>opening_stock</b> is used only for products that have never had stock. After
                  that, use Receive stock or Adjust stock.
                </li>
                <li>
                  Rows whose SKU starts with EXAMPLE- are skipped. In Excel, format the sku and
                  barcode columns as Text so leading zeros are kept.
                </li>
              </ul>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                aria-label="Product CSV"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pick(f);
                }}
              />
              <Button disabled={busy !== null} onClick={() => fileRef.current?.click()}>
                {busy === "read" ? "Checking…" : "Upload edited CSV"}
              </Button>
            </div>
          )}

          {preview && !result && (
            <div className="space-y-3 text-sm" data-testid="product-csv-preview">
              <p className="text-xs text-muted-foreground">{fileName}</p>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <li>
                  <b>{preview.creates.length}</b> new
                </li>
                <li>
                  <b>{preview.updates.length}</b> changed
                </li>
                <li>
                  <b>{preview.unchanged}</b> unchanged
                </li>
                <li className={preview.issues.length ? "text-destructive" : ""}>
                  <b>{preview.issues.length}</b> problem rows
                </li>
              </ul>

              {preview.issues.length > 0 && (
                <div className="rounded-md border border-destructive/40 p-2">
                  <p className="mb-1 font-semibold text-destructive">
                    Fix these rows in the file and upload it again:
                  </p>
                  <ul className="list-disc pl-5 text-xs text-destructive">
                    {preview.issues.map((i) => (
                      <li key={`${i.line}-${i.problem}`}>
                        Line {i.line}
                        {i.sku ? ` (${i.sku})` : ""}: {i.problem}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.duplicates.length > 0 && (
                <div
                  role="alert"
                  data-testid="product-csv-duplicates"
                  className="rounded-md border border-gold/60 bg-gold/10 p-2"
                >
                  <p className="mb-1 font-semibold">
                    {preview.duplicates.length} row{preview.duplicates.length === 1 ? "" : "s"} may
                    duplicate a product you already have
                  </p>
                  <p className="mb-1 text-xs text-muted-foreground">
                    Check them before saving. If a row is the same item, give it the existing
                    product&apos;s SKU so it updates that product instead of adding a second one.
                  </p>
                  <ul className="list-disc pl-5 text-xs">
                    {preview.duplicates.map((d) => (
                      <li key={`${d.line}-${d.sku}`}>
                        Line {d.line} ({d.sku}) {d.name}: {d.problems.join(" ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.creates.length > 0 && (
                <div>
                  <p className="font-semibold">New products</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1">SKU</th>
                        <th>Name</th>
                        <th>Category</th>
                        <th>Price</th>
                        <th>Opening stock</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.creates.map((c) => (
                        <tr key={c.sku} className="border-t border-border">
                          <td className="py-1">{c.sku}</td>
                          <td>{c.name}</td>
                          <td>{c.category}</td>
                          <td>R{c.price}</td>
                          <td>{c.opening_qty || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {preview.updates.length > 0 && (
                <div>
                  <p className="font-semibold">Changes</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1">Product</th>
                        <th>Field</th>
                        <th>Now</th>
                        <th>After upload</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.updates.flatMap((u) =>
                        u.changes.map((c, i) => (
                          <tr
                            key={`${u.sku}-${c.field}`}
                            className={i === 0 ? "border-t border-border" : ""}
                          >
                            <td className="py-1 pr-2">{i === 0 ? `${u.name} (${u.sku})` : ""}</td>
                            <td>{c.field}</td>
                            <td className="text-muted-foreground">{c.from}</td>
                            <td className="font-medium">{c.to}</td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {preview.notes.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-muted-foreground">
                  {preview.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}

              {changes === 0 && preview.issues.length === 0 && (
                <p className="rounded-md bg-secondary p-2">
                  Nothing in this file is different from the shop.
                </p>
              )}

              <div className="flex gap-2">
                <Button
                  disabled={busy !== null || preview.issues.length > 0 || changes === 0}
                  onClick={() => void confirm()}
                >
                  {busy === "save"
                    ? "Saving…"
                    : `Save ${changes} product${changes === 1 ? "" : "s"}`}
                </Button>
                <Button variant="outline" onClick={reset}>
                  Choose another file
                </Button>
              </div>
            </div>
          )}

          {result && (
            <div role="status" className="space-y-1 text-sm">
              <p className="font-semibold">Saved.</p>
              <p>
                {result.created} created · {result.updated} updated
                {result.stocked_products > 0
                  ? ` · opening stock for ${result.stocked_products} (${result.opening_units} units)`
                  : ""}
                {result.sales_ended > 0 ? ` · ${result.sales_ended} sales ended` : ""}
              </p>
              <Button variant="outline" size="sm" onClick={reset}>
                Upload another file
              </Button>
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
