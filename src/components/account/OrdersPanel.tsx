import { useState } from "react";
import { Check, CircleDot, RotateCcw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { rand } from "@/lib/cart";
import { redeemPointsFn, reorderFn, reorderPreviewFn } from "@/lib/member.functions";
import type { MemberAccount } from "@/lib/member-data.server";
import {
  maxRedeemablePoints,
  pointsValueRand,
  statusLabel,
  summariseReorder,
  type ReorderCheck,
} from "@/lib/member-logic";
import { useIdempotencyKey } from "./use-member-account";

type Order = MemberAccount["orders"][number];

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : "Something went wrong. Please try again.";

export function OrderTimeline({ order }: { order: Order }) {
  if (order.timeline.length === 0)
    return <p className="text-xs text-muted-foreground">No updates yet.</p>;
  return (
    <ol className="relative ml-2 border-l border-border">
      {order.timeline.map((event, index) => {
        const latest = index === order.timeline.length - 1;
        return (
          <li key={event.id} className="mb-3 ml-4 last:mb-0">
            <span
              className={
                "absolute -left-[7px] grid h-3.5 w-3.5 place-items-center rounded-full " +
                (latest ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")
              }
            >
              {latest ? <CircleDot size={9} /> : <Check size={9} />}
            </span>
            <p className={"text-xs " + (latest ? "font-semibold" : "text-muted-foreground")}>
              {statusLabel(event.to_status)}
            </p>
            <p className="text-[0.65rem] text-muted-foreground">
              {new Date(event.created_at).toLocaleString("en-ZA", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function RedeemPoints({
  order,
  account,
  onDone,
}: {
  order: Order;
  account: MemberAccount;
  onDone: () => Promise<void>;
}) {
  const { loyalty } = account;
  const subtotal = order.items.reduce((sum, i) => sum + Number(i.unit_price_rand) * i.quantity, 0);
  const max = maxRedeemablePoints(subtotal, loyalty.balance, loyalty.rules);
  const [points, setPoints] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useIdempotencyKey();

  if (order.loyalty_points_redeemed > 0)
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-primary">
        <Sparkles size={13} /> {order.loyalty_points_redeemed} points applied —{" "}
        {rand(Number(order.loyalty_discount_rand))} off
      </p>
    );
  if (max === 0) return null;

  const requested = Number.parseInt(points, 10);
  const valid =
    Number.isInteger(requested) && requested >= loyalty.rules.minRedeemPoints && requested <= max;

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await redeemPointsFn({ data: { orderId: order.id, points: requested, key: key.get() } });
      key.reset();
      setPoints("");
      await onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-dashed border-border p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
        <Sparkles size={13} className="text-primary" /> Use points on this order
      </p>
      <div className="flex items-center gap-2">
        <Input
          inputMode="numeric"
          className="h-9 max-w-[8rem]"
          placeholder={`${loyalty.rules.minRedeemPoints}–${max}`}
          value={points}
          onChange={(e) => setPoints(e.target.value.replace(/\D/g, ""))}
          aria-label="Points to redeem"
        />
        <Button size="sm" disabled={!valid || busy} onClick={() => void apply()}>
          {busy ? "Applying…" : "Apply"}
        </Button>
        <button
          type="button"
          className="text-xs font-semibold text-primary"
          onClick={() => setPoints(String(max))}
        >
          Max
        </button>
      </div>
      <p className="mt-1.5 text-[0.65rem] text-muted-foreground">
        Up to {max} points ({rand(pointsValueRand(max, loyalty.rules))}). Applied once per order.
      </p>
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function ReorderDialog({
  order,
  open,
  onClose,
  onDone,
}: {
  order: Order;
  open: boolean;
  onClose: () => void;
  onDone: (orderNumber: string) => Promise<void>;
}) {
  const [check, setCheck] = useState<ReorderCheck | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useIdempotencyKey();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setCheck((await reorderPreviewFn({ data: { orderId: order.id } })) as ReorderCheck);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  const summary = check ? summariseReorder(check) : null;

  const confirm = async () => {
    if (!check || check.current_total === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await reorderFn({
        data: { orderId: order.id, expectedTotal: Number(check.current_total), key: key.get() },
      })) as { order_number: string };
      key.reset();
      await onDone(result.order_number);
      onClose();
    } catch (err) {
      const message = errorText(err);
      // Price or stock moved while the member was looking: show the fresh numbers AND say why they
      // changed. load() clears the error, so the message is set once the refresh has completed.
      key.reset();
      await load();
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        onOpenAutoFocus={() => {
          setCheck(null);
          void load();
        }}
      >
        <DialogHeader>
          <DialogTitle>Reorder {order.order_number}</DialogTitle>
          <DialogDescription>
            We re-check today&apos;s price and stock before anything is ordered.
          </DialogDescription>
        </DialogHeader>
        {loading && !check && (
          <p className="text-sm text-muted-foreground">Checking availability…</p>
        )}
        {check && (
          <ul className="divide-y divide-border text-sm">
            {check.lines.map((line) => (
              <li
                key={line.product_id ?? line.name}
                className="flex items-start justify-between gap-3 py-2"
              >
                <div>
                  <p className="font-medium">
                    {line.quantity} × {line.name}
                  </p>
                  {line.status === "price_changed" && (
                    <p className="text-xs text-amber-600">
                      Price changed: {rand(Number(line.previous_price))} →{" "}
                      {rand(Number(line.current_price))}
                    </p>
                  )}
                  {line.status === "insufficient_stock" && (
                    <p className="text-xs text-destructive">
                      Only {line.available} available right now
                    </p>
                  )}
                  {line.status === "unavailable" && (
                    <p className="text-xs text-destructive">No longer available</p>
                  )}
                </div>
                {line.current_price !== null && line.status !== "unavailable" && (
                  <b>{rand(Number(line.current_price) * line.quantity)}</b>
                )}
              </li>
            ))}
          </ul>
        )}
        {check && Number(check.delivery_fee ?? 0) > 0 && (
          <p className="text-xs text-muted-foreground">
            Includes delivery {rand(Number(check.delivery_fee))}
          </p>
        )}
        {summary?.message && <p className="text-xs text-muted-foreground">{summary.message}</p>}
        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        )}
        <DialogFooter className="items-center gap-2 sm:justify-between">
          <p className="text-sm font-bold">
            {check && check.current_total !== null
              ? `Total ${rand(Number(check.current_total))}`
              : ""}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!summary?.canReorder || busy || loading}
              onClick={() => void confirm()}
            >
              {busy ? "Placing order…" : "Place order"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OrdersPanel({
  account,
  reload,
  notify,
}: {
  account: MemberAccount;
  reload: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [reordering, setReordering] = useState<Order | null>(null);
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-display text-lg font-bold uppercase">Order history</h2>
      {account.orders.length === 0 && (
        <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          No orders yet. Your orders and their live status will appear here.
        </p>
      )}
      {account.orders.map((order) => {
        const active = order.status !== "completed" && order.status !== "cancelled";
        const expanded = active || open.has(order.id);
        return (
          <div key={order.id} className="rounded-xl border border-border bg-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="font-semibold">{order.order_number}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(order.created_at).toLocaleDateString("en-ZA")}
                </p>
              </div>
              <Badge>{statusLabel(order.status)}</Badge>
            </div>
            <ul className="mb-3 text-xs text-muted-foreground">
              {order.items.map((item) => (
                <li key={item.id}>
                  {item.quantity} × {item.product_name}
                </li>
              ))}
            </ul>
            {Number(order.delivery_fee_rand) > 0 && (
              <p className="text-right text-xs text-muted-foreground">
                Delivery {rand(Number(order.delivery_fee_rand))}
              </p>
            )}
            {Number(order.loyalty_discount_rand) > 0 && (
              <p className="text-right text-xs text-muted-foreground">
                Points discount −{rand(Number(order.loyalty_discount_rand))}
              </p>
            )}
            <p className="text-right text-sm font-bold">{rand(Number(order.total_rand))}</p>

            <div className="mt-3 border-t border-border pt-3">
              {!active && (
                <button
                  type="button"
                  className="mb-2 text-xs font-semibold text-primary"
                  onClick={() => toggle(order.id)}
                >
                  {expanded ? "Hide timeline" : "Show timeline"}
                </button>
              )}
              {expanded && <OrderTimeline order={order} />}
            </div>

            {order.status === "awaiting_payment" && (
              <RedeemPoints order={order} account={account} onDone={reload} />
            )}
            <div className="mt-3 flex justify-end">
              <Button size="sm" variant="outline" onClick={() => setReordering(order)}>
                <RotateCcw size={13} className="mr-1.5" /> Reorder
              </Button>
            </div>
          </div>
        );
      })}
      {reordering && (
        <ReorderDialog
          order={reordering}
          open
          onClose={() => setReordering(null)}
          onDone={async (orderNumber) => {
            notify(`Order ${orderNumber} placed — it is awaiting payment.`);
            await reload();
          }}
        />
      )}
    </div>
  );
}
