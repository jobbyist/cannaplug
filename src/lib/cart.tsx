import { useAuth } from "@/hooks/useAuth";
import { getCartFn, saveCartFn } from "@/lib/cart.functions";
import { snapUp } from "@/lib/sale-step";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { addQty, lineCents, subQty, sumQty } from "@/lib/qty";

export type CartLine = {
  productId: string;
  name: string;
  price: number;
  unit: string | null;
  quantity: number;
  /** How the quantity moves: 5 for Outdoor flower (5 g batches), 0.5 for a product sold in half grams, otherwise 1. */
  step?: number;
};

type CartState = {
  lines: CartLine[];
  count: number;
  total: number;
  add: (line: Omit<CartLine, "quantity">, quantity?: number) => void;
  /** Move a line one step up or down (a whole batch for Outdoor flower); below one step removes it. */
  stepQuantity: (productId: string, direction: 1 | -1) => void;
  setQuantity: (productId: string, quantity: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
};

const STORAGE_KEY = "cannaplug.cart.v1";
const CartContext = createContext<CartState | null>(null);

const stepOf = (line: Pick<CartLine, "step" | "name" | "unit">) =>
  line.step === 0.5 || (line.step && line.step > 1)
    ? line.step
    : /\(outdoor\)\s*$/i.test(line.name) && line.unit === "g"
      ? 5
      : 1;

/** A basket saved before the 5 g rule: Outdoor lines are rounded up to a whole batch. */
function normaliseLines(lines: CartLine[]): CartLine[] {
  return lines.map((l) => {
    const step = stepOf(l);
    return step > 1 ? { ...l, step, quantity: snapUp(l.quantity, step) } : l;
  });
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const { user } = useAuth();
  const userId = user?.id ?? null;
  /** The user whose saved basket has been merged in; saving starts only after that, so an empty browser never wipes it. */
  const [syncedFor, setSyncedFor] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setLines(normaliseLines(JSON.parse(raw) as CartLine[]));
    } catch {
      /* ignore malformed cart */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  }, [lines, hydrated]);

  // Signed in: bring in the basket saved on the server (another device, or an earlier visit) and merge it with this one.
  useEffect(() => {
    if (!hydrated || !userId) {
      setSyncedFor(null);
      return;
    }
    let cancelled = false;
    getCartFn()
      .then((saved) => {
        if (cancelled) return;
        setLines((current) => {
          const merged = new Map(current.map((l) => [l.productId, l]));
          for (const s of saved) {
            const have = merged.get(s.productId);
            if (have)
              merged.set(s.productId, { ...have, quantity: Math.max(have.quantity, s.quantity) });
            else merged.set(s.productId, s);
          }
          return normaliseLines([...merged.values()]);
        });
      })
      .catch(() => {
        /* offline or signed out: the browser copy still works */
      })
      .finally(() => {
        if (!cancelled) setSyncedFor(userId);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrated, userId]);

  // Signed in: keep the saved basket current (a short pause after the last change).
  useEffect(() => {
    if (!userId || syncedFor !== userId) return;
    const timer = window.setTimeout(() => {
      saveCartFn({
        data: { items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) },
      }).catch(() => {
        /* the next change tries again */
      });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [lines, userId, syncedFor]);

  const add = useCallback((line: Omit<CartLine, "quantity">, quantity?: number) => {
    const step = stepOf(line);
    const amount = snapUp(quantity ?? step, step);
    setLines((current) => {
      const existing = current.find((item) => item.productId === line.productId);
      if (existing) {
        return current.map((item) =>
          item.productId === line.productId
            ? { ...item, step, quantity: addQty(item.quantity, amount) }
            : item,
        );
      }
      return [...current, { ...line, step, quantity: amount }];
    });
  }, []);

  const stepQuantity = useCallback((productId: string, direction: 1 | -1) => {
    setLines((current) =>
      current.flatMap((item) => {
        if (item.productId !== productId) return [item];
        const step = stepOf(item);
        const next = direction === 1 ? addQty(item.quantity, step) : subQty(item.quantity, step);
        return next < step ? [] : [{ ...item, step, quantity: next }];
      }),
    );
  }, []);

  const setQuantity = useCallback((productId: string, quantity: number) => {
    setLines((current) =>
      quantity <= 0
        ? current.filter((item) => item.productId !== productId)
        : current.map((item) => (item.productId === productId ? { ...item, quantity } : item)),
    );
  }, []);

  const remove = useCallback((productId: string) => {
    setLines((current) => current.filter((item) => item.productId !== productId));
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const value = useMemo<CartState>(
    () => ({
      lines,
      count: sumQty(lines.map((item) => item.quantity)),
      // each line is priced to the cent (half up) and the lines are added, exactly as the server totals an order
      total: lines.reduce((sum, item) => sum + lineCents(item.price, item.quantity), 0) / 100,
      add,
      stepQuantity,
      setQuantity,
      remove,
      clear,
    }),
    [lines, add, stepQuantity, setQuantity, remove, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart must be used inside CartProvider");
  return context;
}

export const rand = (value: number) =>
  `R${value.toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** An amount to be charged, always with cents (the "Pay R…" button). */
export const randCents = (value: number) =>
  `R${value.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
