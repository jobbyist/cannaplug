import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArchiveOrder } from "@/components/admin/orders/ArchiveOrder";
import {
  isPickup,
  nextStatuses,
  statusLabel,
  statusVariant,
} from "@/components/admin/orders/orders-logic";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { rand } from "@/lib/cart";
import type { AdminOrder, AdminOrderStatus } from "@/lib/admin-data.server";
import { getAdminOrderFn, listAdminOrdersFn } from "@/lib/admin.functions";

export function OrderTable({
  orders,
  onSelect,
}: {
  orders: Awaited<ReturnType<typeof listAdminOrdersFn>>;
  onSelect: (id: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Order</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Total</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => (
          <TableRow key={order.id} className="cursor-pointer" onClick={() => onSelect(order.id)}>
            <TableCell className="font-medium">{order.order_number}</TableCell>
            <TableCell>{order.customer_name ?? "Guest"}</TableCell>
            <TableCell>{rand(order.total_rand)}</TableCell>
            <TableCell>
              <Badge variant={statusVariant(order.status)}>{statusLabel(order.status)}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {new Date(order.created_at).toLocaleDateString("en-ZA")}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function OrdersPanel({
  orders,
  selected,
  onSelect,
  onTransition,
  onConfirmPayment,
  onLoadMore,
  canConfirmPayment = true,
  onArchive,
  showArchived = false,
  onToggleArchived,
}: {
  onLoadMore?: () => Promise<void>;
  /** Managers can archive (hide) cancelled or unpaid orders; omit for everyone else. */
  onArchive?: (orderId: string, archived: boolean, reason: string) => Promise<void>;
  showArchived?: boolean;
  onToggleArchived?: (show: boolean) => void;
  /** Recording an EFT is a manager action (also enforced on the server). */
  canConfirmPayment?: boolean;
  onConfirmPayment: (
    id: string,
    bankReference: string,
    amountReceived: string,
  ) => Promise<{ outcome: string; duplicate: boolean }>;
  orders: Awaited<ReturnType<typeof listAdminOrdersFn>>;
  selected: Awaited<ReturnType<typeof getAdminOrderFn>>;
  onSelect: (id: string) => void;
  onTransition: (id: string, status: AdminOrderStatus) => Promise<void>;
}) {
  // The EFT form unmounts the moment the order is confirmed, so its outcome message lives here.
  const [paymentNote, setPaymentNote] = useState<{ orderId: string; text: string } | null>(null);
  // Unpaid orders are confirmed through the EFT receipt form below (records the bank reference and
  // checks the amount), not by a bare status change.
  const next = selected ? nextStatuses(selected.status, selected.delivery_method) : [];
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-xl font-extrabold uppercase">Orders</h1>
          {onToggleArchived && (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => onToggleArchived(e.target.checked)}
              />
              Show archived orders
            </label>
          )}
        </div>
        <OrderTable orders={orders} onSelect={onSelect} />
        {onLoadMore && (
          <Button variant="outline" size="sm" className="mt-4" onClick={() => void onLoadMore()}>
            Load older orders
          </Button>
        )}
      </div>
      {selected && (
        <aside className="rounded-xl border border-border bg-card p-5">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <p className="font-display text-lg font-bold">{selected.order_number}</p>
              <p className="text-xs text-muted-foreground">
                {selected.customer_name ?? "Customer"}
              </p>
            </div>
            <Badge variant={statusVariant(selected.status)}>{statusLabel(selected.status)}</Badge>
          </div>
          <div className="mb-5 space-y-2 text-xs">
            {selected.items.map((item) => (
              <div key={item.id} className="flex justify-between">
                <span>
                  {item.quantity} × {item.product_name}
                </span>
                <span>{rand(Number(item.unit_price_rand) * item.quantity)}</span>
              </div>
            ))}
          </div>
          {paymentNote && paymentNote.orderId === selected.id && (
            <p
              role="status"
              className="mb-4 rounded-md bg-primary/10 px-3 py-2 text-xs font-medium"
            >
              {paymentNote.text}
            </p>
          )}
          <OrderDelivery order={selected} />
          <div className="border-t border-border pt-4">
            {Number(selected.delivery_fee_rand) > 0 && (
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>Delivery</span>
                <span>{rand(Number(selected.delivery_fee_rand))}</span>
              </div>
            )}
            {Number(selected.loyalty_discount_rand) > 0 && (
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>Points discount ({selected.loyalty_points_redeemed} pts)</span>
                <span>-{rand(Number(selected.loyalty_discount_rand))}</span>
              </div>
            )}
            <div className="mb-4 flex justify-between font-bold">
              <span>Total</span>
              <span>{rand(selected.total_rand)}</span>
            </div>
            {canConfirmPayment && selected.status === "awaiting_payment" && (
              <EftConfirm
                order={selected}
                onConfirm={onConfirmPayment}
                onResult={(text) => setPaymentNote(text ? { orderId: selected.id, text } : null)}
              />
            )}
            <p className="mb-2 text-[0.65rem] font-bold uppercase text-muted-foreground">
              Next fulfilment steps
            </p>
            <div className="flex flex-wrap gap-2">
              {next.map((status) => (
                <Button
                  key={status}
                  size="sm"
                  variant="outline"
                  onClick={() => void onTransition(selected.id, status)}
                >
                  {statusLabel(status)}
                </Button>
              ))}
            </div>
            {!next.length && (
              <p className="text-xs text-muted-foreground">No further transitions.</p>
            )}
          </div>
          {onArchive && (
            <ArchiveOrder
              orderNumber={selected.order_number}
              status={selected.status}
              archivedAt={selected.archived_at ?? null}
              archiveReason={selected.archive_reason ?? null}
              onArchive={(archived, reason) => onArchive(selected.id, archived, reason)}
            />
          )}
        </aside>
      )}
    </div>
  );
}

type AddressSnapshot = {
  label?: string | null;
  recipient_name?: string | null;
  phone?: string | null;
  line1?: string | null;
  line2?: string | null;
  suburb?: string | null;
  city?: string | null;
  province?: string | null;
  postal_code?: string | null;
  delivery_notes?: string | null;
};

function OrderDelivery({
  order,
}: {
  order: NonNullable<Awaited<ReturnType<typeof getAdminOrderFn>>>;
}) {
  const address = (order.delivery_address ?? null) as AddressSnapshot | null;
  const lines = address
    ? [
        address.line1,
        address.line2,
        address.suburb,
        address.city,
        address.province,
        address.postal_code,
      ]
        .filter(Boolean)
        .join(", ")
    : null;
  return (
    <div className="mb-5 space-y-1 rounded-lg border border-border p-3 text-xs">
      <p className="text-[0.65rem] font-bold uppercase text-muted-foreground">
        {isPickup(order.delivery_method) ? "In-store pickup & contact" : "Delivery & contact"}
      </p>
      {isPickup(order.delivery_method) && (
        <p className="rounded bg-[#D4AF37]/15 px-2 py-1 font-semibold text-[#0B3D20] dark:text-[#D4AF37]">
          Customer collects at the shop. Check 18+ ID on collection, then mark Completed.
        </p>
      )}
      <p>
        {order.contact_name ?? order.customer_name ?? "—"}
        {order.contact_phone ? ` · ${order.contact_phone}` : ""}
      </p>
      {order.customer_email && <p className="text-muted-foreground">{order.customer_email}</p>}
      {lines ? (
        <p>
          {address?.recipient_name ? `${address.recipient_name}, ` : ""}
          {lines}
        </p>
      ) : (
        <p className="text-muted-foreground">No delivery address on this order.</p>
      )}
      {address?.delivery_notes && <p className="italic">Notes: {address.delivery_notes}</p>}
      {order.notes && <p className="italic">Customer note: {order.notes}</p>}
      <p className="text-muted-foreground">
        {isPickup(order.delivery_method)
          ? "In-store pickup"
          : order.delivery_method
            ? `${statusLabel(order.delivery_method)} delivery`
            : "No delivery method"}
        {order.payment_method ? ` · Pay by ${order.payment_method.toUpperCase()}` : ""}
      </p>
      {order.prescription && <PrescriptionLine rx={order.prescription} />}
    </div>
  );
}

/** Only the number, validity and a verify link — never clinical text, quantities or practitioner notes. */
function PrescriptionLine({ rx }: { rx: NonNullable<AdminOrder["prescription"]> }) {
  const until = rx.valid_until
    ? new Date(rx.valid_until).toLocaleDateString("en-ZA", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
  return (
    <p className={rx.valid ? "text-primary" : "font-semibold text-destructive"}>
      {rx.valid
        ? `Covered by prescription ${rx.document_number}, valid until ${until}`
        : `Check before packing: prescription ${rx.document_number} is no longer valid${rx.link_status === "flagged" ? " (revoked)" : ""}`}{" "}
      ·{" "}
      <a href={`/verify/${rx.verify_token}`} target="_blank" rel="noreferrer" className="underline">
        Verify
      </a>
    </p>
  );
}

const EFT_MESSAGES: Record<string, string> = {
  confirmed: "Payment recorded — the order is confirmed and stock has been taken.",
  pending_approval:
    "Recorded. This amount needs a SECOND manager to approve it (Payments tab) before the order is confirmed.",
  order_total_changed:
    "The order total changed after this payment was recorded. Nothing was changed.",
  amount_mismatch: "The amount received does not match the order total. Nothing was changed.",
  already_processed: "This order has already been processed.",
  paid_after_cancel_needs_refund: "This order was cancelled — the payment needs a refund.",
  stock_unavailable_needs_refund:
    "The hold expired and stock is no longer available — refund the customer.",
  order_not_found: "Order not found.",
};

function EftConfirm({
  order,
  onConfirm,
  onResult,
}: {
  order: NonNullable<Awaited<ReturnType<typeof getAdminOrderFn>>>;
  /** Reports the outcome to the parent: this form unmounts as soon as the order leaves awaiting_payment. */
  onResult: (text: string | null) => void;
  onConfirm: (
    id: string,
    bankReference: string,
    amountReceived: string,
  ) => Promise<{ outcome: string; duplicate: boolean }>;
}) {
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState(String(order.total_rand));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setReference("");
    setAmount(String(order.total_rand));
  }, [order.id, order.total_rand]);
  const valid = reference.trim().length >= 4 && /^[0-9]{1,8}(\.[0-9]{1,2})?$/.test(amount);
  return (
    <div className="mb-4 rounded-lg border border-dashed border-border p-3">
      <p className="mb-2 text-[0.65rem] font-bold uppercase text-muted-foreground">
        Confirm EFT received (manager)
      </p>
      <p className="mb-2 text-[0.65rem] text-muted-foreground">
        Customer reference: <b>{order.order_number}</b>. Enter the bank reference and the amount
        that cleared. Each bank reference can be used once.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="Bank reference"
          placeholder="Bank reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <Input
          aria-label="Amount received"
          className="w-28"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <Button
        size="sm"
        className="mt-2"
        disabled={!valid || busy}
        onClick={async () => {
          setBusy(true);
          onResult(null);
          try {
            const result = await onConfirm(order.id, reference.trim(), amount);
            onResult(
              result.duplicate
                ? "That bank reference was already recorded."
                : (EFT_MESSAGES[result.outcome] ?? result.outcome),
            );
          } catch (err) {
            onResult(err instanceof Error ? err.message : "Could not record the payment.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Recording…" : "Confirm payment"}
      </Button>
    </div>
  );
}
