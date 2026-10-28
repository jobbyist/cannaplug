import { useCallback, useEffect, useRef, useState } from "react";
import { FlaskConical, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { rand } from "@/lib/cart";
import { getDemoTillCatalogFn } from "@/lib/pos.functions";
import { OpenTill, SaleScreen, type DemoHooks } from "./PosPanel";
import { CloseTill, TillExpenses, type CloseSession, type ExpenseActions } from "./TillCashup";
import {
  applyDemoSale,
  demoReceiptNumber,
  simulateClose,
  takeDemoStock,
  type DemoExpense,
} from "./demo-logic";
import { parseCents, type CatalogItem } from "./pos-logic";

type DemoSession = { id: string; opening_float: number; opened_at: string };

const DRAWER_ID = "demo-drawer";

/**
 * Demo till (managers and admins): the real till screens on a throwaway copy of the catalogue. It only ever READS the
 * catalogue. Opening and closing the till, sales, expenses, the bank deposit and the cash-up all happen in this
 * browser tab and are gone on reset or reload: no sale, stock movement, till session, expense, payment, receipt
 * record or audit entry reaches the database.
 */
export function DemoTill() {
  const [stock, setStock] = useState<CatalogItem[] | null>(null);
  const [fresh, setFresh] = useState<CatalogItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<DemoSession | null>(null);
  const [expenses, setExpenses] = useState<DemoExpense[]>([]);
  const [salesCount, setSalesCount] = useState(0);
  const [cashSalesCents, setCashSalesCents] = useState(0);
  const [discountsCents, setDiscountsCents] = useState(0);
  const [carriedFloat, setCarriedFloat] = useState<number | null>(null);
  const receiptNo = useRef(0);
  const ids = useRef(0);

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
    nextReceiptNumber: () => demoReceiptNumber(++receiptNo.current),
    onSold: ({ lines, receipt, discountCents }) => {
      setSalesCount((n) => n + 1);
      setDiscountsCents((c) => c + discountCents);
      setCashSalesCents(
        (c) =>
          c +
          receipt.sale.tenders
            .filter((t) => t.method === "cash")
            .reduce((s, t) => s + Math.round(t.amount * 100), 0),
      );
      setStock((cur) => (cur ? takeDemoStock(cur, lines) : cur));
    },
    setSale: async (input) => {
      setStock((cur) => (cur ? applyDemoSale(cur, input) : cur));
    },
  };

  const expenseActions: ExpenseActions = {
    add: async (d) => {
      setExpenses((cur) => [
        ...cur,
        {
          id: `demo-exp-${++ids.current}`,
          amount: Number(d.amount),
          category: d.category,
          description: d.description,
          created_at: new Date().toISOString(),
          mine: true,
        },
      ]);
    },
    remove: async (d) => {
      setExpenses((cur) => cur.filter((e) => e.id !== d.expenseId));
    },
  };

  const closeSession: CloseSession = async (d) => {
    const result = simulateClose({
      openingFloat: session?.opening_float ?? 0,
      cashSalesCents,
      expenses,
      discountsCents,
      salesCount,
      actualCash: d.actualCash,
      cashDeposited: d.cashDeposited,
    });
    setCarriedFloat(Number(result.float_carried));
    return result;
  };

  const resetSession = () => {
    setSession(null);
    setExpenses([]);
    setSalesCount(0);
    setCashSalesCents(0);
    setDiscountsCents(0);
  };

  const reset = () => {
    receiptNo.current = 0;
    resetSession();
    setCarriedFloat(null);
    setStock(fresh);
  };

  const cashup = {
    expenses,
    expensesTotal: expenses.reduce((s, e) => s + Math.round(e.amount * 100), 0) / 100,
    discountsTotal: discountsCents / 100,
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
          {session && (
            <Badge variant="secondary">
              Demo till open · {salesCount} practice sale{salesCount === 1 ? "" : "s"} ·{" "}
              {rand(cashSalesCents / 100)} cash
            </Badge>
          )}
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
          <b>Test transactions only.</b> Opening and closing this till, sales, expenses, the bank
          deposit and the cash-up are practice. They do not appear in sales, reports, stock, till
          cash-up, loyalty, the audit log or notifications, and no receipt is printed or emailed.
          Everything exists only in this tab until you press Reset or reload. Refunds and voids are
          not simulated.
        </p>
      </div>

      {error && !stock && (
        <div className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {!stock && !error && <p className="text-xs text-muted-foreground">Loading products…</p>}
      {stock && !session && (
        <OpenTill
          data={{
            isManager: true,
            drawers: [
              {
                id: DRAWER_ID,
                name: "Demo drawer",
                location: null,
                is_active: true,
                in_use: false,
                carried_float: carriedFloat,
              },
            ] as never,
          }}
          onChanged={async () => {}}
          demoOpen={(_drawerId, openingFloat) => {
            resetSession();
            setSession({
              id: "demo-session",
              opening_float: (parseCents(openingFloat) ?? 0) / 100,
              opened_at: new Date().toISOString(),
            });
          }}
        />
      )}
      {stock && session && (
        <>
          <SaleScreen
            data={{ catalog: stock }}
            session={{ id: session.id }}
            onChanged={async () => {}}
            demo={hooks}
          />
          <TillExpenses
            sessionId={session.id}
            cashup={cashup}
            isManager
            onChanged={async () => {}}
            actions={expenseActions}
          />
          <CloseTill
            session={session}
            cashup={cashup}
            onChanged={async () => resetSession()}
            closeSession={closeSession}
          />
        </>
      )}
    </div>
  );
}
