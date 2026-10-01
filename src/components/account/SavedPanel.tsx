import { useState } from "react";
import { Bell, BellOff, Heart } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { rand } from "@/lib/cart";
import { getCatalogImage } from "@/fixtures/catalog-presentation";
import { setStockAlertFn, setWishlistFn } from "@/lib/member.functions";
import type { MemberAccount } from "@/lib/member-data.server";

type Product = MemberAccount["products"][number];

export function SavedPanel({
  account,
  reload,
}: {
  account: MemberAccount;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saved = new Set(account.wishlist);
  const active = new Set(
    account.alerts.filter((a) => a.status === "active").map((a) => a.product_id),
  );
  const notified = new Set(
    account.alerts.filter((a) => a.status === "notified").map((a) => a.product_id),
  );

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const savedProducts = account.wishlist
    .map((id) => account.products.find((p) => p.id === id))
    .filter((p): p is Product => Boolean(p));
  const others = account.products.filter((p) => !saved.has(p.id));

  const card = (p: Product) => (
    <div key={p.id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
      <img src={getCatalogImage(p.category)} alt="" className="h-14 w-14 rounded-lg object-cover" />
      <div className="flex-1">
        <p className="text-sm font-semibold">{p.name}</p>
        <p className="text-xs text-muted-foreground">{p.subcategory ?? p.category}</p>
        {!p.in_stock && (
          <Badge variant="secondary" className="mt-1">
            {notified.has(p.id) && !active.has(p.id) ? "Back soon" : "Out of stock"}
          </Badge>
        )}
        {p.in_stock && notified.has(p.id) && <Badge className="mt-1">Back in stock</Badge>}
      </div>
      <div className="flex flex-col items-end gap-2">
        <b className="text-sm">{rand(Number(p.price_rand))}</b>
        <div className="flex items-center gap-1">
          {!p.in_stock && (
            <button
              type="button"
              disabled={busy === p.id}
              aria-label={
                active.has(p.id) ? "Stop back-in-stock alert" : "Notify me when back in stock"
              }
              title={active.has(p.id) ? "Alert on — tap to stop" : "Notify me when back in stock"}
              onClick={() =>
                void act(p.id, () =>
                  setStockAlertFn({ data: { productId: p.id, enabled: !active.has(p.id) } }),
                )
              }
              className="rounded-full p-1.5 text-primary hover:bg-muted disabled:opacity-50"
            >
              {active.has(p.id) ? <Bell size={16} fill="currentColor" /> : <BellOff size={16} />}
            </button>
          )}
          <button
            type="button"
            disabled={busy === p.id}
            aria-label={saved.has(p.id) ? "Remove from saved" : "Save product"}
            onClick={() =>
              void act(p.id, () =>
                setWishlistFn({ data: { productId: p.id, saved: !saved.has(p.id) } }),
              )
            }
            className="rounded-full p-1.5 text-primary hover:bg-muted disabled:opacity-50"
          >
            <Heart size={16} fill={saved.has(p.id) ? "currentColor" : "none"} />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="mb-4 font-display text-lg font-bold uppercase">Saved Products</h2>
        {error && (
          <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {savedProducts.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            Nothing saved yet. Tap the heart on any product below to keep it here.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {savedProducts.map(card)}
          </div>
        )}
      </div>
      {others.length > 0 && (
        <div>
          <h3 className="mb-3 font-display text-sm font-bold uppercase">More from the shop</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {others.map(card)}
          </div>
        </div>
      )}
    </div>
  );
}
