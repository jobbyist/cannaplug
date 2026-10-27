import { useEffect, useMemo, useState } from "react";
import { BadgePercent } from "lucide-react";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { rand } from "@/lib/cart";
import { setProductSaleFn } from "@/lib/admin.functions";
import {
  fromLocalInput,
  percentOff,
  saleEndsLabel,
  endsAtFor,
  saleProblem,
  type SaleEnds as Ends,
  salePriceFromPercent,
  toLocalInput,
} from "@/lib/sale-price";
import type { CatalogItem } from "./pos-logic";

export type SetSale = (input: {
  productId: string;
  salePrice: number | null;
  endsAt: string | null;
}) => Promise<unknown>;

const serverSetSale: SetSale = (data) => setProductSaleFn({ data });

/**
 * Managers put a product on sale (or end its sale) straight from the till. The sale price applies at the till
 * and online, and the regular price comes back by itself at the end time.
 */
export function PosSaleDialog({
  product,
  onOpenChange,
  onDone,
  setSale = serverSetSale,
}: {
  product: CatalogItem | null;
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => Promise<void> | void;
  setSale?: SetSale;
}) {
  const regular = product ? Number(product.regular_price_rand ?? product.price_rand) : 0;
  const onSale = product?.regular_price_rand != null;
  const [mode, setMode] = useState<"percent" | "price">("percent");
  const [percent, setPercent] = useState("");
  const [price, setPrice] = useState("");
  const [ends, setEnds] = useState<Ends>("none");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!product) return;
    setError(null);
    if (product.regular_price_rand != null) {
      setMode("price");
      setPrice(String(product.price_rand));
      setPercent(String(percentOff(regular, product.price_rand)));
      setEnds(product.sale_ends_at ? "custom" : "none");
      setCustom(toLocalInput(product.sale_ends_at));
    } else {
      setMode("percent");
      setPercent("");
      setPrice("");
      setEnds("none");
      setCustom("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);

  const sale = useMemo(() => {
    if (mode === "percent") {
      const p = Number(percent);
      return percent !== "" && p > 0 ? salePriceFromPercent(regular, p) : null;
    }
    const v = Number(price.replace(",", "."));
    return price !== "" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  }, [mode, percent, price, regular]);
  const endsAt = endsAtFor(ends, custom);
  const problem =
    sale == null
      ? mode === "percent"
        ? "Choose how much off."
        : "Enter the sale price."
      : saleProblem({ price: regular, sale, endsAt });

  const run = async (salePrice: number | null) => {
    if (!product) return;
    setBusy(true);
    setError(null);
    try {
      await setSale({
        productId: product.id,
        salePrice,
        endsAt: salePrice == null ? null : endsAt,
      });
      onOpenChange(false);
      await onDone(
        salePrice == null
          ? `${product.name} is back to ${rand(regular)}.`
          : `${product.name} is on sale for ${rand(salePrice)} (was ${rand(regular)})${endsAt ? `, ${saleEndsLabel(endsAt)?.toLowerCase()}` : ""}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the sale.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!product} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BadgePercent size={18} className="text-[#D4AF37]" />
            {onSale ? "Change sale" : "Put on sale"}
          </DialogTitle>
          <DialogDescription>
            {product?.name} · regular price {rand(regular)}. Applies at the till and online.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <ToggleGroup
            type="single"
            variant="outline"
            value={mode}
            onValueChange={(v) => v && setMode(v as "percent" | "price")}
            className="grid grid-cols-2"
          >
            <ToggleGroupItem value="percent">% off</ToggleGroupItem>
            <ToggleGroupItem value="price">Sale price</ToggleGroupItem>
          </ToggleGroup>
          {mode === "percent" ? (
            <div className="grid gap-2">
              <Label htmlFor="pos-sale-pct">Discount</Label>
              <div className="flex flex-wrap gap-1.5">
                {[5, 10, 15, 20, 25, 30, 50].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPercent(String(p))}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold ${percent === String(p) ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}
                  >
                    {p}%
                  </button>
                ))}
              </div>
              <Input
                id="pos-sale-pct"
                inputMode="numeric"
                placeholder="Other %"
                className="w-32"
                value={percent}
                onChange={(e) => setPercent(e.target.value.replace(/\D/g, "").slice(0, 2))}
              />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="pos-sale-price">Sale price (R)</Label>
              <Input
                id="pos-sale-price"
                inputMode="decimal"
                className="w-40"
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(/[^\d.,]/g, ""))}
              />
            </div>
          )}
          <div className="grid gap-2">
            <Label>Sale ends</Label>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["none", "No end date"],
                  ["today", "Tonight"],
                  ["3d", "3 days"],
                  ["7d", "1 week"],
                  ["custom", "Pick a time"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setEnds(v)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${ends === v ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {ends === "custom" && (
              <Input
                aria-label="Sale end time"
                type="datetime-local"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
            )}
          </div>
          {sale != null && (
            <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm" data-testid="pos-sale-preview">
              {rand(regular)} → <b>{rand(sale)}</b>{" "}
              <span className="text-xs text-muted-foreground">
                ({percentOff(regular, sale)}% off, saves{" "}
                {rand(Math.round((regular - sale) * 100) / 100)})
                {endsAt ? ` · ${saleEndsLabel(endsAt)}` : ""}
              </span>
            </p>
          )}
          {(error || (sale != null && problem)) && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error ?? problem}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2">
          {onSale && (
            <Button variant="outline" disabled={busy} onClick={() => void run(null)}>
              End sale now
            </Button>
          )}
          <Button disabled={busy || !!problem} onClick={() => void run(sale)}>
            {onSale ? "Update sale" : "Start sale"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
