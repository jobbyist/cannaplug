import { CommerceSuspendedBanner } from "@/components/CommerceSuspendedBanner";
import { useCommerceSuspended } from "@/hooks/use-commerce-suspended";
import { StaffBadge } from "@/components/StaffBadge";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Landmark,
  Lock,
  MapPin,
  Minus,
  Plus,
  ShoppingBag,
  Store,
  Trash2,
  Truck,
} from "lucide-react";
import { Header } from "@/components/CannaPlugHome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import { useCart } from "@/lib/cart";
import { rand, randCents } from "@/lib/cart";
import { eftRows, type EftDetails } from "@/lib/payments/eft";
import {
  clearPendingCheckout,
  loadPendingCheckout,
  savePendingCheckout,
} from "@/lib/payments/pending-checkout";
import { PaymentPanel } from "@/components/checkout/PaymentPanel";
import {
  listCheckoutAddressesFn,
  listDeliveryOptionsFn,
  placeOrderFn,
  quoteCheckoutFn,
} from "@/lib/checkout.functions";
import { getOnlineMethodsFn, getPaypalRateFn, paymentStatusFn } from "@/lib/payments.functions";
import { saveAddressFn } from "@/lib/member.functions";
import { getMyVerificationFn } from "@/lib/verification.functions";
import { verificationView, type VerificationView } from "@/lib/verification-logic";
import type { CheckoutQuote, PlacedOrder } from "@/lib/checkout-data.server";

export const Route = createFileRoute("/checkout")({
  head: () => ({ meta: [{ title: "Checkout | CannaPlug" }] }),
  component: CheckoutPage,
});

const STEPS = ["Cart", "Details", "Delivery", "Payment", "Confirmation"] as const;
type Step = (typeof STEPS)[number];

type DeliveryOption = {
  code: string;
  label: string;
  description: string | null;
  fee_rand: number;
  is_pickup?: boolean;
  pickup_address?: string | null;
};
type SavedAddress = {
  id: string;
  label: string;
  recipient_name: string | null;
  phone: string | null;
  line1: string;
  line2: string | null;
  suburb: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  delivery_notes: string | null;
  is_default: boolean;
};

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : "Something went wrong. Please try again.";

const addressLine = (a: SavedAddress) =>
  [a.line1, a.line2, a.suburb, a.city, a.province, a.postal_code].filter(Boolean).join(", ");

function Stepper({ step }: { step: Step }) {
  const index = STEPS.indexOf(step);
  return (
    <ol className="mb-8 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide">
      {STEPS.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className={
              "flex h-7 w-7 items-center justify-center rounded-full border text-[0.65rem] " +
              (i < index
                ? "border-primary bg-primary text-primary-foreground"
                : i === index
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground")
            }
          >
            {i < index ? <Check size={13} /> : i + 1}
          </span>
          <span className={i === index ? "text-foreground" : "text-muted-foreground"}>{label}</span>
          {i < STEPS.length - 1 && <ChevronRight size={14} className="text-muted-foreground" />}
        </li>
      ))}
    </ol>
  );
}

/** Shows the SERVER's quote when there is one; otherwise a clearly labelled estimate. */
function OrderSummary({
  quote,
  deliveryFee,
}: {
  quote: CheckoutQuote | null;
  deliveryFee: number | null;
}) {
  const { lines, total } = useCart();
  const [open, setOpen] = useState(false);
  const estimate = quote === null;
  const grand = quote ? quote.total : total + (deliveryFee ?? 0);
  const grandText = quote && quote.total === null ? "—" : rand(grand ?? 0);
  return (
    <aside
      aria-label="Order summary"
      className="order-first h-fit rounded-xl border border-border bg-card p-5 lg:order-none lg:sticky lg:top-24"
    >
      {/* Mobile: a one-line summary that expands; desktop: always open. */}
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 lg:hidden"
        aria-expanded={open}
        aria-controls="order-summary-body"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2 font-display text-sm font-bold uppercase">
          <ShoppingBag size={15} className="text-primary" /> {open ? "Hide" : "Show"} order summary
          <ChevronDown size={15} className={"transition " + (open ? "rotate-180" : "")} />
        </span>
        <span className="text-sm font-bold">{grandText}</span>
      </button>
      <h2 className="mb-4 hidden font-display text-sm font-bold uppercase lg:block">
        Order summary
      </h2>
      <div
        id="order-summary-body"
        className={(open ? "mt-4 block" : "hidden") + " lg:mt-0 lg:block"}
      >
        <ul className="mb-4 flex flex-col gap-3">
          {(quote
            ? quote.lines.map((l) => ({
                key: l.product_id,
                name: l.name,
                quantity: l.quantity,
                amount: l.line_total,
                problem: l.status !== "ok",
              }))
            : lines.map((l) => ({
                key: l.productId,
                name: l.name,
                quantity: l.quantity,
                amount: l.price * l.quantity,
                problem: false,
              }))
          ).map((line) => (
            <li key={line.key} className="flex items-center justify-between gap-3 text-xs">
              <span className={line.problem ? "text-destructive" : "text-foreground"}>
                {line.name} <span className="text-muted-foreground">× {line.quantity}</span>
                {line.problem && " — unavailable"}
              </span>
              <span className="font-semibold">
                {line.amount === null ? "—" : rand(line.amount)}
              </span>
            </li>
          ))}
          {lines.length === 0 && (
            <li className="text-xs text-muted-foreground">Your cart is empty.</li>
          )}
        </ul>
        <div className="flex flex-col gap-2 border-t border-border pt-3 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{rand(quote ? quote.subtotal : total)}</span>
          </div>
          {quote?.staff_purchase && (
            <div className="flex justify-between" data-testid="staff-rate-row">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                Staff rate ({quote.staff_percent ?? 20}% off) <StaffBadge />
              </span>
              <span className="font-semibold text-primary">−{rand(quote.staff_discount ?? 0)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Delivery</span>
            <span>
              {quote ? rand(quote.delivery_fee) : deliveryFee !== null ? rand(deliveryFee) : "—"}
            </span>
          </div>
          <div className="mt-1 flex justify-between border-t border-border pt-2 text-sm font-bold">
            <span>Total{estimate ? " (estimate)" : ""}</span>
            <span>{grandText}</span>
          </div>
          {estimate && (
            <p className="text-[0.65rem] text-muted-foreground">
              Final prices and stock are confirmed before you place the order.
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}

function CheckoutPage() {
  const { user } = useAuth();
  const { lines, stepQuantity, remove, clear } = useCart();
  const [step, setStep] = useState<Step>("Cart");

  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [notes, setNotes] = useState("");

  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [addressesLoaded, setAddressesLoaded] = useState(false);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    line1: "",
    suburb: "",
    city: "",
    province: "",
    postal_code: "",
  });

  const [options, setOptions] = useState<DeliveryOption[]>([]);
  const [delivery, setDelivery] = useState<string | null>(null);
  // How the order reaches the member: delivered to a saved address, or collected in store.
  const [fulfil, setFulfil] = useState<"delivery" | "pickup">("delivery");

  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [placed, setPlaced] = useState<PlacedOrder | null>(null);
  const [methods, setMethods] = useState<{
    card: boolean;
    cardOnsite?: boolean;
    paypal: boolean;
    eft: EftDetails | null;
  } | null>(null);
  const [payMethod, setPayMethod] = useState<"eft" | "card" | "paypal" | null>(null);
  const [usdRate, setUsdRate] = useState<number | null>(null);
  // Starts the payment right after placing; false when resuming after a refresh (the member clicks Pay).
  const [autoPay, setAutoPay] = useState(false);
  const checkoutPaused = useCommerceSuspended().suspended;
  useEffect(() => {
    let live = true;
    getOnlineMethodsFn()
      .then((m) => {
        if (!live) return;
        setMethods(m);
        // Card first (confirmed automatically), then bank transfer, then PayPal.
        setPayMethod(
          (cur) => cur ?? (m.card ? "card" : m.eft ? "eft" : m.paypal ? "paypal" : null),
        );
        if (m.paypal)
          void getPaypalRateFn()
            .then((r) => live && setUsdRate(r?.zarPerUsd ?? null))
            .catch(() => undefined);
      })
      .catch(() => live && setMethods({ card: false, paypal: false, eft: null }));
    return () => {
      live = false;
    };
  }, []);

  const memberId = user?.id;
  // A refresh, a closed tab or an interrupted payment window must not lose the order: if this tab placed an
  // order that is still waiting for payment, reopen it. The server (owner-scoped) is the source of truth.
  useEffect(() => {
    const pending = loadPendingCheckout();
    if (!pending || !memberId) return;
    let live = true;
    paymentStatusFn({ data: { orderId: pending.orderId } })
      .then((s) => {
        if (!live) return;
        if (!s || s.paid || s.orderStatus !== "awaiting_payment") {
          clearPendingCheckout();
          return;
        }
        setPayMethod(pending.method);
        setPlaced({
          order_id: pending.orderId,
          order_number: s.orderNumber,
          status: s.orderStatus,
          subtotal: s.total,
          delivery_fee: 0,
          total: s.total,
          payment_method: pending.method,
          hold_minutes: 0,
        });
        setStep("Confirmation");
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [memberId]);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orderKey = useIdempotencyKey();

  // Online orders need an approved ID. The database enforces it; this only explains it up front.
  const [idStatus, setIdStatus] = useState<VerificationView | null>(null);
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = () =>
      getMyVerificationFn()
        .then((row) => !cancelled && setIdStatus(verificationView(row)))
        .catch(() => undefined);
    void load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [userId]);

  // Prefill the name ONCE when the member is known; never overwrite what they have typed or cleared
  // (a token refresh hands us a new `user` object).
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current) return;
    const name = user?.user_metadata?.["full_name"];
    if (typeof name === "string") {
      prefilled.current = true;
      setContactName((current) => current || name);
    }
  }, [user]);

  useEffect(() => {
    void listDeliveryOptionsFn()
      .then((rows) => {
        const list = rows as DeliveryOption[];
        setOptions(list);
        // Delivery is paused: when the server offers only pickup, start (and stay) on pickup.
        const pickupOnly = !list.some((o) => !o.is_pickup);
        if (pickupOnly) setFulfil("pickup");
        setDelivery(
          (current) =>
            current ??
            (pickupOnly ? list.find((o) => o.is_pickup) : list.find((o) => !o.is_pickup))?.code ??
            null,
        );
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  const loadAddresses = useCallback(async (selectId?: string) => {
    try {
      const rows = (await listCheckoutAddressesFn()) as SavedAddress[];
      setAddresses(rows);
      setAddressId(
        (current) =>
          selectId ?? current ?? rows.find((a) => a.is_default)?.id ?? rows[0]?.id ?? null,
      );
      setAddressesLoaded(true);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    if (user && step === "Details" && !addressesLoaded) void loadAddresses();
  }, [user, step, addressesLoaded, loadAddresses]);

  const cartKey = lines.map((l) => `${l.productId}:${l.quantity}`).join(",");
  useEffect(() => {
    if (step !== "Payment" || !delivery || lines.length === 0) return;
    let cancelled = false;
    setQuoting(true);
    quoteCheckoutFn({
      data: {
        items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
        deliveryMethod: delivery,
      },
    })
      .then((q) => !cancelled && setQuote(q as CheckoutQuote))
      .catch((err) => !cancelled && setError(errorText(err)))
      .finally(() => !cancelled && setQuoting(false));
    return () => {
      cancelled = true;
    };
    // `lines` is represented by cartKey so quantity edits re-quote without refetch loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, delivery, cartKey]);

  const deliveryFee = options.find((o) => o.code === delivery)?.fee_rand ?? null;
  const pickupOption = options.find((o) => o.is_pickup) ?? null;
  const deliveryAvailable = options.some((o) => !o.is_pickup);
  const shownOptions = options.filter((o) => Boolean(o.is_pickup) === (fulfil === "pickup"));
  const chooseFulfil = (next: "delivery" | "pickup") => {
    setFulfil(next);
    setQuote(null);
    setDelivery(options.find((o) => Boolean(o.is_pickup) === (next === "pickup"))?.code ?? null);
  };
  const needsAddress = fulfil === "delivery";
  const selectedAddress = addresses.find((a) => a.id === addressId) ?? null;
  const contactValid =
    contactName.trim().length >= 2 && /^[0-9+() -]{7,40}$/.test(contactPhone.trim());

  const saveNewAddress = async () => {
    setError(null);
    try {
      const saved = (await saveAddressFn({
        data: {
          address: { label: "Delivery", ...draft },
          makeDefault: addresses.length === 0,
        },
      })) as { id: string };
      setAdding(false);
      setDraft({ line1: "", suburb: "", city: "", province: "", postal_code: "" });
      await loadAddresses(saved.id);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const placeOrder = async () => {
    if (!quote || quote.total === null || !delivery || (needsAddress && !addressId) || !payMethod)
      return;
    setPlacing(true);
    setError(null);
    try {
      const result = await placeOrderFn({
        data: {
          items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
          contactName: contactName.trim(),
          contactPhone: contactPhone.trim(),
          deliveryMethod: delivery,
          addressId: needsAddress ? addressId : null,
          paymentMethod: payMethod,
          expectedTotal: quote.total,
          notes: notes.trim() === "" ? null : notes.trim(),
          key: orderKey.get(),
        },
      });
      // The cart is only emptied once the server has confirmed the order exists.
      orderKey.reset();
      const order = result as PlacedOrder;
      if (payMethod !== "eft")
        savePendingCheckout({
          orderId: order.order_id,
          orderNumber: order.order_number,
          method: payMethod,
        });
      setPlaced(order);
      clear();
      setAutoPay(payMethod !== "eft");
      setStep("Confirmation");
    } catch (err) {
      setError(errorText(err));
      // Price or stock moved while the member was reviewing: show the fresh numbers and a fresh intent.
      orderKey.reset();
      try {
        setQuote(
          (await quoteCheckoutFn({
            data: {
              items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
              deliveryMethod: delivery,
            },
          })) as CheckoutQuote,
        );
      } catch {
        /* the error above is already shown */
      }
    } finally {
      setPlacing(false);
    }
  };

  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };

  return (
    <div className="site">
      <Header />
      <main className="mx-auto w-full max-w-[1180px] px-4 py-10 sm:px-6 lg:px-8">
        <h1 className="mb-1 font-display text-2xl font-extrabold uppercase sm:text-3xl">
          Checkout
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          A quick, secure path from cart to confirmation.
        </p>
        {checkoutPaused && step !== "Confirmation" && (
          <div className="mb-4">
            <CommerceSuspendedBanner kind="checkout" />
          </div>
        )}
        <Stepper step={step} />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
            {error && step !== "Confirmation" && (
              <p
                role="alert"
                className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </p>
            )}

            {step === "Cart" && (
              <div className="flex flex-col gap-4">
                {lines.length === 0 && (
                  <div className="flex flex-col items-center gap-3 py-10 text-center">
                    <ShoppingBag className="text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Your cart is empty.</p>
                    <Link to="/shop">
                      <Button size="sm">Browse the shop</Button>
                    </Link>
                  </div>
                )}
                {lines.map((line) => (
                  <div
                    key={line.productId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                  >
                    <div>
                      <p className="text-sm font-semibold">{line.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {rand(line.price)} {line.unit ? `/ ${line.unit}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1 rounded-full border border-border px-1">
                        <button
                          aria-label="Decrease quantity"
                          className="grid h-7 w-7 place-items-center"
                          onClick={() => stepQuantity(line.productId, -1)}
                        >
                          <Minus size={13} />
                        </button>
                        <span className="w-5 text-center text-xs font-semibold">
                          {line.quantity}
                        </span>
                        <button
                          aria-label="Increase quantity"
                          className="grid h-7 w-7 place-items-center"
                          onClick={() => stepQuantity(line.productId, 1)}
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                      <button
                        aria-label={`Remove ${line.name}`}
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => remove(line.productId)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
                {lines.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Have loyalty points? You can apply them to your order from{" "}
                    <b>My Account → Orders</b> after you place it.
                  </p>
                )}
                <Button
                  className="self-end"
                  disabled={lines.length === 0}
                  onClick={() => go("Details")}
                >
                  Continue <ChevronRight size={15} />
                </Button>
              </div>
            )}

            {step === "Details" &&
              (!user ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <Lock className="text-muted-foreground" />
                  <p className="max-w-sm text-sm text-muted-foreground">
                    Sign in to your CannaPlug account to save delivery details and track this order.
                  </p>
                  <Link to="/account">
                    <Button size="sm">Sign in to continue</Button>
                  </Link>
                  <button
                    className="text-xs text-muted-foreground underline"
                    onClick={() => go("Cart")}
                  >
                    Back to cart
                  </button>
                </div>
              ) : idStatus && !idStatus.canOrder ? (
                <div
                  role="status"
                  className="flex flex-col items-center gap-3 py-10 text-center"
                  data-testid="checkout-id-gate"
                >
                  <Lock className="text-muted-foreground" />
                  <p className="font-display text-sm font-bold uppercase">{idStatus.headline}</p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {idStatus.detail} Your cart is saved.
                  </p>
                  <Link to="/account">
                    <Button size="sm">
                      {idStatus.status === "pending" ? "View status" : "Verify my ID"}
                    </Button>
                  </Link>
                  <button
                    className="text-xs text-muted-foreground underline"
                    onClick={() => go("Cart")}
                  >
                    Back to cart
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="co-name">Full name</Label>
                      <Input
                        id="co-name"
                        value={contactName}
                        onChange={(e) => setContactName(e.target.value)}
                        placeholder="Your name"
                        required
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="co-email">Email</Label>
                      <Input
                        id="co-email"
                        type="email"
                        value={user.email ?? ""}
                        readOnly
                        disabled
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="co-phone">Phone</Label>
                      <Input
                        id="co-phone"
                        value={contactPhone}
                        onChange={(e) => setContactPhone(e.target.value)}
                        placeholder="+27 XX XXX XXXX"
                        required
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="co-notes">
                        {needsAddress ? "Delivery notes (optional)" : "Notes (optional)"}
                      </Label>
                      <Input
                        id="co-notes"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        maxLength={500}
                        placeholder="Gate code, best time…"
                      />
                    </div>
                  </div>

                  {pickupOption && !deliveryAvailable && (
                    <p
                      role="status"
                      className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
                    >
                      <b>In-store pickup only for now.</b> Delivery is coming soon. Collect your
                      order at {pickupOption.pickup_address ?? "the shop"} — free, and we email you
                      when it's ready.
                    </p>
                  )}
                  {pickupOption && deliveryAvailable && (
                    <fieldset className="grid gap-2 sm:grid-cols-2">
                      <legend className="mb-2 text-xs font-bold uppercase text-muted-foreground">
                        How would you like to get your order?
                      </legend>
                      {(
                        [
                          ["delivery", "Delivery", "To your door"],
                          [
                            "pickup",
                            "In-store pickup",
                            `Free · ${pickupOption.pickup_address ?? "at the shop"}`,
                          ],
                        ] as const
                      ).map(([value, label, hint]) => (
                        <label
                          key={value}
                          className={
                            "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition " +
                            (fulfil === value ? "border-primary bg-primary/5" : "border-border")
                          }
                        >
                          <input
                            type="radio"
                            name="fulfil"
                            className="mt-1 accent-primary"
                            checked={fulfil === value}
                            onChange={() => chooseFulfil(value)}
                          />
                          <span>
                            <span className="block font-semibold">{label}</span>
                            <span className="text-xs text-muted-foreground">{hint}</span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )}

                  {needsAddress ? (
                    <div>
                      <p className="mb-2 text-xs font-bold uppercase text-muted-foreground">
                        Delivery address
                      </p>
                      <div className="flex flex-col gap-2">
                        {addresses.map((a) => (
                          <label
                            key={a.id}
                            className={
                              "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition " +
                              (addressId === a.id ? "border-primary bg-primary/5" : "border-border")
                            }
                          >
                            <input
                              type="radio"
                              name="address"
                              className="mt-1 accent-primary"
                              checked={addressId === a.id}
                              onChange={() => setAddressId(a.id)}
                            />
                            <MapPin size={16} className="mt-0.5 text-primary" />
                            <span className="text-xs">
                              <b className="text-sm">{a.label}</b>
                              <br />
                              <span className="text-muted-foreground">{addressLine(a)}</span>
                            </span>
                          </label>
                        ))}
                        {addressesLoaded && addresses.length === 0 && !adding && (
                          <p className="text-xs text-muted-foreground">
                            You have no saved addresses yet.
                          </p>
                        )}
                      </div>
                      {adding ? (
                        <div className="mt-3 grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
                          <div className="grid gap-1.5 sm:col-span-2">
                            <Label htmlFor="co-line1">Street address</Label>
                            <Input
                              id="co-line1"
                              value={draft.line1}
                              onChange={(e) => setDraft({ ...draft, line1: e.target.value })}
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <Label htmlFor="co-suburb">Suburb</Label>
                            <Input
                              id="co-suburb"
                              value={draft.suburb}
                              onChange={(e) => setDraft({ ...draft, suburb: e.target.value })}
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <Label htmlFor="co-city">City</Label>
                            <Input
                              id="co-city"
                              value={draft.city}
                              onChange={(e) => setDraft({ ...draft, city: e.target.value })}
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <Label htmlFor="co-province">Province</Label>
                            <Input
                              id="co-province"
                              value={draft.province}
                              onChange={(e) => setDraft({ ...draft, province: e.target.value })}
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <Label htmlFor="co-postal">Postal code</Label>
                            <Input
                              id="co-postal"
                              value={draft.postal_code}
                              onChange={(e) => setDraft({ ...draft, postal_code: e.target.value })}
                            />
                          </div>
                          <div className="flex gap-2 sm:col-span-2">
                            <Button
                              size="sm"
                              disabled={
                                draft.line1.trim().length < 3 ||
                                (draft.city.trim() === "" && draft.suburb.trim() === "")
                              }
                              onClick={() => void saveNewAddress()}
                            >
                              Save address
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="mt-3 text-xs font-semibold text-primary"
                          onClick={() => setAdding(true)}
                        >
                          + Add a new address
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-[#D4AF37]/50 bg-[#D4AF37]/10 p-3 text-xs">
                      Collect at <b>{pickupOption?.pickup_address}</b>. We'll email you when your
                      order is ready. Bring your ID: we check it on collection.
                    </p>
                  )}

                  <div className="flex justify-between">
                    <Button variant="outline" onClick={() => go("Cart")}>
                      Back
                    </Button>
                    <Button
                      disabled={!contactValid || (needsAddress && !addressId)}
                      onClick={() => go("Delivery")}
                    >
                      Continue <ChevronRight size={15} />
                    </Button>
                  </div>
                </div>
              ))}

            {step === "Delivery" && (
              <div className="flex flex-col gap-4">
                {needsAddress && selectedAddress && (
                  <p className="text-xs text-muted-foreground">
                    Delivering to <b>{selectedAddress.label}</b> — {addressLine(selectedAddress)}
                  </p>
                )}
                {shownOptions.map((option) => (
                  <label
                    key={option.code}
                    className={
                      "flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-4 transition " +
                      (delivery === option.code ? "border-primary bg-primary/5" : "border-border")
                    }
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="radio"
                        name="delivery"
                        className="accent-primary"
                        checked={delivery === option.code}
                        onChange={() => setDelivery(option.code)}
                      />
                      {option.is_pickup ? (
                        <Store size={18} className="text-primary" />
                      ) : (
                        <Truck size={18} className="text-primary" />
                      )}
                      <div>
                        <p className="text-sm font-semibold">{option.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {option.is_pickup ? option.pickup_address : option.description}
                        </p>
                      </div>
                    </div>
                    <b className="text-sm">{rand(Number(option.fee_rand))}</b>
                  </label>
                ))}
                {options.length === 0 && (
                  <p className="text-xs text-muted-foreground">Loading delivery options…</p>
                )}
                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => go("Details")}>
                    Back
                  </Button>
                  <Button disabled={!delivery} onClick={() => go("Payment")}>
                    Continue <ChevronRight size={15} />
                  </Button>
                </div>
              </div>
            )}

            {step === "Payment" && (
              <div className="flex flex-col gap-4">
                {(
                  [
                    methods?.cardOnsite
                      ? {
                          id: "card" as const,
                          icon: CreditCard,
                          title: "Card, Instant EFT or Masterpass (PayFast)",
                          body: "Pay in rand right here, in PayFast's secure payment window — you never leave Cannaplug. Your card details go straight to PayFast; we never see them. Your order is confirmed automatically once PayFast verifies the payment.",
                          show: true,
                        }
                      : {
                          id: "card" as const,
                          icon: CreditCard,
                          title: "Card, Instant EFT, Apple Pay or Google Pay (PayFast)",
                          body: "Pay in rand on PayFast's secure page with your card, Instant EFT, Apple Pay or Google Pay. Your order is confirmed automatically once PayFast verifies the payment.",
                          show: !!methods?.card,
                        },
                    {
                      id: "eft" as const,
                      icon: Landmark,
                      title: "Bank transfer (EFT)",
                      body: "Place your order now and we hold your items for 2 hours. Pay by EFT using your order number as the reference — we confirm and dispatch as soon as the payment clears.",
                      show: !!methods?.eft,
                    },
                    {
                      id: "paypal" as const,
                      icon: Lock,
                      title: "PayPal (US dollars)",
                      body:
                        "PayPal charges in US dollars. We convert your rand total at today's rate plus a small conversion margin; PayPal shows the exact amount before you pay." +
                        (usdRate && quote?.total != null
                          ? ` About US$${(Math.ceil((quote.total / usdRate) * 100) / 100).toFixed(2)} today (R${usdRate.toFixed(2)} = US$1).`
                          : ""),
                      show: !!methods?.paypal,
                    },
                  ] as const
                )
                  .filter((o) => o.show)
                  .map((o) => (
                    <label
                      key={o.id}
                      className={
                        "flex cursor-pointer items-start gap-3 rounded-lg border p-4 " +
                        (payMethod === o.id ? "border-primary bg-primary/5" : "border-border")
                      }
                    >
                      <input
                        type="radio"
                        name="payment-method"
                        checked={payMethod === o.id}
                        onChange={() => setPayMethod(o.id)}
                        className="mt-1 accent-primary"
                      />
                      <o.icon size={18} className="mt-0.5 text-primary" />
                      <span>
                        <span className="text-sm font-semibold">{o.title}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">{o.body}</span>
                      </span>
                    </label>
                  ))}
                {methods && !methods.card && !methods.eft && !methods.paypal && (
                  <p className="rounded-md bg-muted px-3 py-2 text-xs">
                    Online payment is being set up. Please contact the shop on +27 68 291 2107 to
                    place your order.
                  </p>
                )}
                {quote && !quote.orderable && (
                  <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    Some items are no longer available in the quantity in your basket. Please update
                    your cart to continue.
                  </p>
                )}
                {quote?.orderable && quote.total !== null && payMethod && (
                  <p className="text-[0.7rem] text-muted-foreground">
                    {payMethod === "eft"
                      ? "Your order is held for you while we wait for the transfer."
                      : `You will pay ${randCents(quote.total)}${payMethod === "paypal" ? " (charged by PayPal in US dollars)" : ""}. We reserve your order first, then open the secure payment.`}{" "}
                    By placing this order you agree to our{" "}
                    <Link to="/terms-of-service" className="underline">
                      terms
                    </Link>{" "}
                    and{" "}
                    <Link to="/refund-policy" className="underline">
                      refund policy
                    </Link>
                    .
                  </p>
                )}
                {/* On phones the total and the pay button stay in reach while scrolling the methods. */}
                <div className="sticky bottom-0 z-10 -mx-5 flex items-center justify-between gap-2 border-t border-border bg-card/95 px-5 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
                  <Button variant="outline" onClick={() => go("Delivery")}>
                    Back
                  </Button>
                  <div className="flex gap-2">
                    {quote && !quote.orderable && (
                      <Button variant="outline" onClick={() => go("Cart")}>
                        Edit cart
                      </Button>
                    )}
                    <Button
                      disabled={
                        checkoutPaused ||
                        placing ||
                        quoting ||
                        !payMethod ||
                        !quote ||
                        !quote.orderable ||
                        quote.total === null
                      }
                      onClick={() => void placeOrder()}
                    >
                      {placing
                        ? "Placing order…"
                        : quoting
                          ? "Checking prices…"
                          : payMethod === "eft" || payMethod === null || quote?.total == null
                            ? `Place order${quote?.total != null ? ` · ${rand(quote.total)}` : ""}`
                            : `Pay ${randCents(quote.total)}`}{" "}
                      <ChevronRight size={15} />
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {step === "Confirmation" && placed && (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                {placed.payment_method === "eft" ? (
                  <>
                    <span className="grid h-14 w-14 place-items-center rounded-full bg-primary text-primary-foreground">
                      <Check size={26} />
                    </span>
                    <h2 className="font-display text-xl font-extrabold uppercase">Order placed</h2>
                    <p className="max-w-md text-sm text-muted-foreground">
                      Thanks{user?.email ? `, ${user.email}` : ""} — order{" "}
                      <b>{placed.order_number}</b> is reserved for you for{" "}
                      {placed.hold_minutes / 60} hours. Please pay{" "}
                      <b>{rand(Number(placed.total))}</b> by EFT using <b>{placed.order_number}</b>{" "}
                      as the payment reference.
                    </p>
                    <dl className="w-full max-w-sm rounded-lg border border-border p-4 text-left text-xs">
                      {(methods?.eft ? eftRows(methods.eft) : []).map(([label, value]) => (
                        <div key={label} className="flex justify-between gap-3 py-1">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="font-semibold">{value}</dd>
                        </div>
                      ))}
                      <div className="flex justify-between gap-3 border-t border-border py-1 pt-2">
                        <dt className="text-muted-foreground">Reference</dt>
                        <dd className="font-semibold">{placed.order_number}</dd>
                      </div>
                    </dl>
                    <p className="max-w-sm text-xs text-muted-foreground">
                      Your order is not dispatched until the payment has cleared. You can follow its
                      progress live in your account.
                    </p>
                  </>
                ) : (
                  <>
                    <span className="grid h-14 w-14 place-items-center rounded-full bg-[#D4AF37]/15 text-[#0B3D20] dark:text-[#D4AF37]">
                      <Lock size={24} />
                    </span>
                    <h2 className="font-display text-xl font-extrabold uppercase">
                      Complete your payment
                    </h2>
                    <p className="max-w-md text-sm text-muted-foreground">
                      Order <b>{placed.order_number}</b> is reserved for you. It is confirmed once
                      your payment is verified.
                    </p>
                    <PaymentPanel
                      key={placed.order_id}
                      orderId={placed.order_id}
                      orderNumber={placed.order_number}
                      method={placed.payment_method === "paypal" ? "paypal" : "card"}
                      total={placed.payment_method === "paypal" ? null : Number(placed.total)}
                      onsite={!!methods?.cardOnsite}
                      autoStart={autoPay}
                    />
                  </>
                )}
                <Link to="/account">
                  <Button size="sm" variant="outline">
                    View your orders
                  </Button>
                </Link>
              </div>
            )}
          </div>

          {step !== "Confirmation" && (
            <OrderSummary
              quote={step === "Payment" ? quote : null}
              deliveryFee={step === "Cart" || step === "Details" ? null : deliveryFee}
            />
          )}
        </div>
      </main>
    </div>
  );
}
