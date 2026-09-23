import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Minus, Plus, ShoppingBag, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useCart, rand } from "@/lib/cart";

export function CartDrawer({
  trigger,
  open,
  onOpenChange,
}: {
  trigger: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { lines, count, total, setQuantity, remove } = useCart();
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const sheetOpen = isControlled ? open : internalOpen;
  const setSheetOpen = isControlled ? (onOpenChange ?? (() => {})) : setInternalOpen;

  return (
    <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
      {trigger}
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border px-6 py-5 text-left">
          <SheetTitle className="flex items-center gap-2 font-display text-base font-bold uppercase">
            <ShoppingBag size={18} /> Your cart{" "}
            {count > 0 && <span className="text-muted-foreground">({count})</span>}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {lines.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
              <ShoppingBag className="text-muted-foreground" size={32} />
              <p className="text-sm text-muted-foreground">Your cart is empty.</p>
              <SheetClose asChild>
                <Link to="/shop">
                  <Button size="sm">Browse the shop</Button>
                </Link>
              </SheetClose>
            </div>
          ) : (
            <ul className="flex flex-col gap-4">
              {lines.map((line) => (
                <li
                  key={line.productId}
                  className="flex items-center gap-3 border-b border-border pb-4 last:border-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{line.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {rand(line.price)} {line.unit ? `/ ${line.unit}` : ""}
                    </p>
                    <div className="mt-2 flex items-center gap-1 rounded-full border border-border px-1 w-fit">
                      <button
                        aria-label={`Decrease quantity of ${line.name}`}
                        className="grid h-7 w-7 place-items-center"
                        onClick={() => setQuantity(line.productId, line.quantity - 1)}
                      >
                        <Minus size={13} />
                      </button>
                      <span className="w-5 text-center text-xs font-semibold">{line.quantity}</span>
                      <button
                        aria-label={`Increase quantity of ${line.name}`}
                        className="grid h-7 w-7 place-items-center"
                        onClick={() => setQuantity(line.productId, line.quantity + 1)}
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <b className="text-sm">{rand(line.price * line.quantity)}</b>
                    <button
                      aria-label={`Remove ${line.name} from cart`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => remove(line.productId)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {lines.length > 0 && (
          <SheetFooter className="flex-col gap-3 border-t border-border px-6 py-5 sm:flex-col">
            <div className="flex w-full items-center justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <b className="font-display text-base">{rand(total)}</b>
            </div>
            <p className="w-full text-[0.68rem] text-muted-foreground">
              Delivery and any promo discounts are calculated at checkout.
            </p>
            <SheetClose asChild>
              <Link to="/checkout" className="w-full">
                <Button className="w-full">View cart & checkout</Button>
              </Link>
            </SheetClose>
            <SheetClose asChild>
              <Link to="/shop" className="w-full">
                <Button variant="outline" className="w-full">
                  Continue shopping
                </Button>
              </Link>
            </SheetClose>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
