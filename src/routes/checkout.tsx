import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Check, ChevronRight, CreditCard, Lock, Minus, Plus, ShoppingBag, Trash2, Truck } from "lucide-react";
import { Header } from "@/components/CannaPlugHome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { useCart } from "@/lib/cart";
import { rand } from "@/lib/cart";

export const Route = createFileRoute("/checkout")({
  head: () => ({ meta: [{ title: "Checkout | CannaPlug" }] }),
  component: CheckoutPage,
});

const STEPS = ["Cart", "Details", "Delivery", "Payment", "Confirmation"] as const;
type Step = (typeof STEPS)[number];

const DELIVERY_OPTIONS = [
  { id: "standard", label: "Standard delivery", copy: "2–3 working days", price: 80 },
  { id: "discreet", label: "Discreet delivery", copy: "Plain packaging, in-hand", price: 120 },
] as const;

const PAYMENT_METHODS = [
  { id: "card", label: "Credit / Debit card", icon: CreditCard },
  { id: "eft", label: "EFT / Bank transfer", icon: Lock },
  { id: "snapscan", label: "SnapScan", icon: ShoppingBag },
] as const;

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

function OrderSummary({ deliveryPrice, promoDiscount }: { deliveryPrice: number; promoDiscount: number }) {
  const { lines, total } = useCart();
  const grandTotal = Math.max(total + deliveryPrice - promoDiscount, 0);
  return (
    <aside className="h-fit rounded-xl border border-border bg-card p-5">
      <h2 className="mb-4 font-display text-sm font-bold uppercase">Order summary</h2>
      <ul className="mb-4 flex flex-col gap-3">
        {lines.map((line) => (
          <li key={line.productId} className="flex items-center justify-between gap-3 text-xs">
            <span className="text-foreground">
              {line.name} <span className="text-muted-foreground">× {line.quantity}</span>
            </span>
            <span className="font-semibold">{rand(line.price * line.quantity)}</span>
          </li>
        ))}
        {lines.length === 0 && <li className="text-xs text-muted-foreground">Your cart is empty.</li>}
      </ul>
      <div className="flex flex-col gap-2 border-t border-border pt-3 text-xs">
        <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{rand(total)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Delivery</span><span>{deliveryPrice ? rand(deliveryPrice) : "—"}</span></div>
        {promoDiscount > 0 && (
          <div className="flex justify-between text-primary"><span>Promo discount</span><span>-{rand(promoDiscount)}</span></div>
        )}
        <div className="mt-1 flex justify-between border-t border-border pt-2 text-sm font-bold"><span>Total</span><span>{rand(grandTotal)}</span></div>
      </div>
    </aside>
  );
}

function CheckoutPage() {
  const { user } = useAuth();
  const { lines, setQuantity, remove, clear } = useCart();
  const [step, setStep] = useState<Step>("Cart");
  const [delivery, setDelivery] = useState<(typeof DELIVERY_OPTIONS)[number]["id"]>("standard");
  const [payment, setPayment] = useState<(typeof PAYMENT_METHODS)[number]["id"]>("card");
  const [promo, setPromo] = useState("");
  const [promoDiscount, setPromoDiscount] = useState(0);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);

  const deliveryPrice = DELIVERY_OPTIONS.find((d) => d.id === delivery)?.price ?? 0;

  const applyPromo = (event: FormEvent) => {
    event.preventDefault();
    setPromoDiscount(promo.trim().toUpperCase() === "PLUGBACK10" ? 100 : 0);
  };

  const placeOrder = () => {
    setOrderNumber(`CP-${Math.floor(10000 + Math.random() * 89999)}`);
    setStep("Confirmation");
    clear();
  };

  return (
    <div className="site">
      <Header />
      <main className="mx-auto w-full max-w-[1180px] px-4 py-10 sm:px-6 lg:px-8">
        <h1 className="mb-1 font-display text-2xl font-extrabold uppercase sm:text-3xl">Checkout</h1>
        <p className="mb-6 text-sm text-muted-foreground">A quick, secure path from cart to confirmation.</p>
        <Stepper step={step} />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
            {step === "Cart" && (
              <div className="flex flex-col gap-4">
                {lines.length === 0 && (
                  <div className="flex flex-col items-center gap-3 py-10 text-center">
                    <ShoppingBag className="text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Your cart is empty.</p>
                    <Link to="/shop"><Button size="sm">Browse the shop</Button></Link>
                  </div>
                )}
                {lines.map((line) => (
                  <div key={line.productId} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                    <div>
                      <p className="text-sm font-semibold">{line.name}</p>
                      <p className="text-xs text-muted-foreground">{rand(line.price)} {line.unit ? `/ ${line.unit}` : ""}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1 rounded-full border border-border px-1">
                        <button aria-label="Decrease quantity" className="grid h-7 w-7 place-items-center" onClick={() => setQuantity(line.productId, line.quantity - 1)}><Minus size={13} /></button>
                        <span className="w-5 text-center text-xs font-semibold">{line.quantity}</span>
                        <button aria-label="Increase quantity" className="grid h-7 w-7 place-items-center" onClick={() => setQuantity(line.productId, line.quantity + 1)}><Plus size={13} /></button>
                      </div>
                      <button aria-label={`Remove ${line.name}`} className="text-muted-foreground hover:text-destructive" onClick={() => remove(line.productId)}><Trash2 size={16} /></button>
                    </div>
                  </div>
                ))}
                <form onSubmit={applyPromo} className="mt-2 flex gap-2">
                  <Input value={promo} onChange={(e) => setPromo(e.target.value)} placeholder="Promo code (try PLUGBACK10)" />
                  <Button type="submit" variant="outline" size="sm">Apply</Button>
                </form>
                <Button className="self-end" disabled={lines.length === 0} onClick={() => setStep("Details")}>
                  Continue <ChevronRight size={15} />
                </Button>
              </div>
            )}

            {step === "Details" && (
              !user ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <Lock className="text-muted-foreground" />
                  <p className="max-w-sm text-sm text-muted-foreground">Sign in to your CannaPlug account to save delivery details and track this order.</p>
                  <Link to="/account"><Button size="sm">Sign in to continue</Button></Link>
                  <button className="text-xs text-muted-foreground underline" onClick={() => setStep("Cart")}>Back to cart</button>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5"><Label>Full name</Label><Input defaultValue={(user.user_metadata?.["full_name"] as string | undefined) ?? ""} placeholder="Your name" required /></div>
                    <div className="grid gap-1.5"><Label>Email</Label><Input type="email" defaultValue={user.email ?? ""} placeholder="you@example.com" required /></div>
                    <div className="grid gap-1.5"><Label>Phone</Label><Input placeholder="+27 XX XXX XXXX" required /></div>
                    <div className="grid gap-1.5"><Label>Postal code</Label><Input placeholder="0002" required /></div>
                    <div className="grid gap-1.5 sm:col-span-2"><Label>Delivery address</Label><Input placeholder="Street address, suburb, city" required /></div>
                  </div>
                  <div className="flex justify-between">
                    <Button variant="outline" onClick={() => setStep("Cart")}>Back</Button>
                    <Button onClick={() => setStep("Delivery")}>Continue <ChevronRight size={15} /></Button>
                  </div>
                </div>
              )
            )}

            {step === "Delivery" && (
              <div className="flex flex-col gap-4">
                {DELIVERY_OPTIONS.map((option) => (
                  <label
                    key={option.id}
                    className={
                      "flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-4 transition " +
                      (delivery === option.id ? "border-primary bg-primary/5" : "border-border")
                    }
                  >
                    <div className="flex items-center gap-3">
                      <input type="radio" name="delivery" className="accent-primary" checked={delivery === option.id} onChange={() => setDelivery(option.id)} />
                      <Truck size={18} className="text-primary" />
                      <div>
                        <p className="text-sm font-semibold">{option.label}</p>
                        <p className="text-xs text-muted-foreground">{option.copy}</p>
                      </div>
                    </div>
                    <b className="text-sm">{rand(option.price)}</b>
                  </label>
                ))}
                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setStep("Details")}>Back</Button>
                  <Button onClick={() => setStep("Payment")}>Continue <ChevronRight size={15} /></Button>
                </div>
              </div>
            )}

            {step === "Payment" && (
              <div className="flex flex-col gap-4">
                {PAYMENT_METHODS.map((method) => (
                  <label
                    key={method.id}
                    className={
                      "flex cursor-pointer items-center gap-3 rounded-lg border p-4 transition " +
                      (payment === method.id ? "border-primary bg-primary/5" : "border-border")
                    }
                  >
                    <input type="radio" name="payment" className="accent-primary" checked={payment === method.id} onChange={() => setPayment(method.id)} />
                    <method.icon size={18} className="text-primary" />
                    <span className="text-sm font-semibold">{method.label}</span>
                  </label>
                ))}
                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setStep("Delivery")}>Back</Button>
                  <Button onClick={placeOrder}>Place order <ChevronRight size={15} /></Button>
                </div>
              </div>
            )}

            {step === "Confirmation" && (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <span className="grid h-14 w-14 place-items-center rounded-full bg-primary text-primary-foreground"><Check size={26} /></span>
                <h2 className="font-display text-xl font-extrabold uppercase">Order confirmed</h2>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Thanks{user?.email ? `, ${user.email}` : ""} — order <b>{orderNumber}</b> is being prepared. This is a
                  presentation prototype, so no payment was actually captured.
                </p>
                <Link to="/account"><Button size="sm">View your orders</Button></Link>
              </div>
            )}
          </div>

          {step !== "Confirmation" && <OrderSummary deliveryPrice={step === "Cart" || step === "Details" ? 0 : deliveryPrice} promoDiscount={promoDiscount} />}
        </div>
      </main>
    </div>
  );
}
