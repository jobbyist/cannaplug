import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReceiptView } from "@/components/admin/receipts/ReceiptView";
import { getReceiptSettingsFn, saveReceiptSettingsFn } from "@/lib/receipts.functions";
import {
  buildReceiptModel,
  PAPER_SIZES,
  type PaperSize,
  type ReceiptSettings,
} from "@/lib/receipts/receipt-model";

const PREVIEW_SALE = {
  sale: {
    receipt_number: "POS-PREVIEW-000001",
    created_at: new Date().toISOString(),
    status: "completed",
    subtotal: 290,
    total: 290,
  },
  items: [
    {
      product_name: "Sample flower (Top Shelf)",
      quantity: 2,
      unit_price_rand: 120,
      line_total: 240,
      unit: "g",
    },
    { product_name: "Sample drink", quantity: 1, unit_price_rand: 50, line_total: 50 },
  ],
  tenders: [{ method: "cash", amount: 290, reference: null }],
  cashierName: "Staff",
  customerName: null,
  cashReceived: 300,
  loyaltyPoints: null,
};

/** /admin → Settings → Receipts. Managers edit what prints on every receipt, including the VAT switch. */
export function ReceiptSettingsPanel() {
  const [form, setForm] = useState<ReceiptSettings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PaperSize>("80mm");

  useEffect(() => {
    getReceiptSettingsFn()
      .then((s) => setForm(s))
      .catch((e) => setMessage(e instanceof Error ? e.message : "Could not load settings."));
  }, []);

  if (!form)
    return (
      <p className="text-sm text-muted-foreground">{message ?? "Loading receipt settings…"}</p>
    );
  const set = <K extends keyof ReceiptSettings>(k: K, v: ReceiptSettings[K]) =>
    setForm({ ...form, [k]: v });
  const text = (k: keyof ReceiptSettings, label: string) => (
    <div className="space-y-1">
      <Label htmlFor={`rs-${k}`}>{label}</Label>
      <Input
        id={`rs-${k}`}
        value={(form[k] as string | null) ?? ""}
        onChange={(e) => set(k, (e.target.value || null) as never)}
      />
    </div>
  );

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setForm(await saveReceiptSettingsFn({ data: form }));
      setMessage("Receipt settings saved.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="font-display text-xl font-extrabold uppercase">Settings · Receipts</h1>
      <p className="mb-4 text-xs text-muted-foreground">
        What prints on every till receipt. Managers only.
      </p>
      <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {text("trading_name", "Trading name")}
          {text("legal_name", "Legal name")}
          {text("registration_number", "Company registration number")}
          {text("phone", "Phone")}
          {text("email", "Email")}
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="rs-address">Address</Label>
            <Input
              id="rs-address"
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="rs-licence">Licence lines (one per line, up to 4)</Label>
            <textarea
              id="rs-licence"
              className="min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={form.licence_lines.join("\n")}
              onChange={(e) =>
                set(
                  "licence_lines",
                  e.target.value
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean)
                    .slice(0, 4),
                )
              }
            />
          </div>
          {text("footer_message", "Footer message")}
          {text("returns_policy", "Returns line")}
          <div className="space-y-2 rounded-md border border-border p-3 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={form.vat_registered}
                onChange={(e) => set("vat_registered", e.target.checked)}
              />
              Charge VAT (prices include VAT; receipts become tax invoices)
            </label>
            {form.vat_registered && (
              <div className="grid grid-cols-2 gap-3">
                {text("vat_number", "VAT number")}
                <div className="space-y-1">
                  <Label htmlFor="rs-vat-rate">VAT rate (%)</Label>
                  <Input
                    id="rs-vat-rate"
                    type="number"
                    step="0.01"
                    value={form.vat_rate}
                    onChange={(e) => set("vat_rate", Number(e.target.value))}
                  />
                </div>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="rs-paper">Default paper</Label>
            <select
              id="rs-paper"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={form.default_paper}
              onChange={(e) => set("default_paper", e.target.value as PaperSize)}
            >
              <option value="80mm">80 mm thermal</option>
              <option value="58mm">58 mm thermal</option>
              <option value="a4">A4</option>
            </select>
          </div>
          <div className="flex items-end gap-2 sm:col-span-2">
            <Button disabled={busy} onClick={() => void save()}>
              Save
            </Button>
            {message && (
              <p role="status" className="text-sm">
                {message}
              </p>
            )}
          </div>
        </div>
        <div>
          <div className="mb-2 flex gap-1">
            {PAPER_SIZES.map((p) => (
              <Button
                key={p}
                size="sm"
                variant={p === preview ? "default" : "outline"}
                onClick={() => setPreview(p)}
              >
                {p === "a4" ? "A4" : p.replace("mm", " mm")}
              </Button>
            ))}
          </div>
          <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-white p-3">
            <ReceiptView
              receipt={buildReceiptModel({ ...PREVIEW_SALE, settings: form })}
              paper={preview}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
