import { useCallback, useEffect, useRef, useState } from "react";
import { FlaskConical, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDemoTillCatalogFn } from "@/lib/pos.functions";
import { SaleScreen, type DemoHooks } from "./PosPanel";
import { applyDemoSale, demoReceiptNumber, takeDemoStock } from "./demo-logic";
import type { CatalogItem } from "./pos-logic";

/**
 * Demo till (managers and admins): the real till screen on a throwaway copy of the catalogue. It only ever READS the
 * catalogue. Completing a sale, a "sale price" or a stock change happens in this browser tab and is gone on reset or
 * reload: no sale, no stock movement, no payment, no receipt record and no audit entry reaches the database.
 */
export function DemoTill() {
  const [stock, setStock] = useState<CatalogItem[] | null>(null);
  const [fresh, setFresh] = useState<CatalogItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sold, setSold] = useState(0);
  const counter = useRef(0);

  const load = useCallback(async () => {
    try {
      const { catalog } = await getDemoTillCatalogFn();
      setFresh(catalog as CatalogItem[]);
      setStock(catalog as CatalogItem[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the products.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const hooks: DemoHooks = {
    nextReceiptNumber: () => demoReceiptNumber(++counter.current),
    onSold: (lines) => {
      setSold((n) => n + 1);
      setStock((cur) => (cur ? takeDemoStock(cur, lines) : cur));
    },
    setSale: async (input) => {
      setStock((cur) => (cur ? applyDemoSale(cur, input) : cur));
    },
  };

  const reset = () => {
    counter.current = 0;
    setSold(0);
    setStock(fresh);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold uppercase">Demo till</h1>
          <p className="text-sm text-muted-foreground">
            Practice the till without recording anything. Nothing here is a real sale.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">
            {sold} practice sale{sold === 1 ? "" : "s"}
          </Badge>
          <Button type="button" variant="outline" size="sm" onClick={reset} disabled={!stock}>
            <RotateCcw size={14} className="mr-1" /> Reset demo
          </Button>
        </div>
      </div>

      <div
        role="note"
        data-testid="demo-till-banner"
        className="flex items-start gap-3 rounded-xl border border-gold/60 bg-gold/10 p-4 text-sm"
      >
        <FlaskConical size={18} className="mt-0.5 shrink-0" />
        <p>
          <b>Test transactions only.</b> Demo sales do not appear in sales, reports, stock, till
          cash-up, loyalty, the audit log or notifications, and no receipt is printed or emailed.
          Stock and sale prices changed here exist only in this tab until you press Reset or reload.
        </p>
      </div>

      {error && !stock && (
        <div className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {!stock && !error && <p className="text-xs text-muted-foreground">Loading products…</p>}
      {stock && (
        <SaleScreen
          data={{ catalog: stock }}
          session={{ id: "demo" }}
          onChanged={async () => {}}
          demo={hooks}
        />
      )}
    </div>
  );
}
