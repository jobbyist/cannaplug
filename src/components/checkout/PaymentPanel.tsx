import { useCallback, useEffect, useRef, useState } from "react";
import { CreditCard, Loader2, Lock, RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { randCents } from "@/lib/cart";
import { paymentStatusFn, startPaymentFn } from "@/lib/payments.functions";
import { presentPayment, returnUrl } from "@/lib/payments/onsite";

type Method = "card" | "paypal";
type Phase =
  | "idle"
  | "starting"
  | "window"
  | "closed"
  | "checking"
  | "leaving" // to the provider's own page
  | "redirecting" // to our confirmation page
  | "error";

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : "We could not start that payment. Please try again.";

/**
 * Pays one existing order. The browser names the order and the method; the amount comes back from the server
 * (`startPaymentFn` reads it from the database) and is what the button shows once known.
 *
 * Card payments open PayFast's own payment window on this page when the server prepared one (PayFast onsite),
 * otherwise PayFast's hosted page. Closing the window, or PayFast saying "done", proves nothing: the member is
 * taken to /payment/return, which waits for the server's verified status.
 */
export function PaymentPanel({
  orderId,
  orderNumber,
  method,
  total,
  onsite,
  autoStart = false,
  navigate = (url: string) => window.location.assign(url),
}: {
  orderId: string;
  orderNumber: string;
  method: Method;
  /** The server's order total, for display before the payment amount is known. */
  total: number | null;
  /** Whether the server offers PayFast's on-page window (copy only; the server decides per attempt). */
  onsite: boolean;
  autoStart?: boolean;
  navigate?: (url: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [amount, setAmount] = useState<number | null>(total);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const pay = useCallback(async () => {
    if (busy.current) return; // one attempt at a time, whatever the clicks
    busy.current = true;
    const retry = phase === "closed" || phase === "error";
    setPhase("starting");
    setError(null);
    try {
      // Before a second attempt, make sure the first did not go through after all.
      if (retry && (await paymentStatusFn({ data: { orderId } }))?.paid) {
        setPhase("redirecting");
        navigate(returnUrl(orderId, method, "success"));
        return;
      }
      const started = await startPaymentFn({
        data: {
          orderId,
          provider: method === "card" ? "payfast" : "paypal",
          key: crypto.randomUUID(),
        },
      });
      if (!live.current) return;
      if (started.currency === "ZAR" && typeof started.amount === "number")
        setAmount(started.amount);
      const outcome = await presentPayment(started, {
        onWindowOpen: () => live.current && setPhase("window"),
      });
      if (!live.current) return;
      if (outcome === "redirected") {
        setPhase("leaving");
        return; // the browser is leaving; keep the button locked
      }
      if (outcome === "completed") {
        setPhase("redirecting");
        navigate(returnUrl(orderId, method, "success"));
        return;
      }
      setPhase("closed");
    } catch (err) {
      if (!live.current) return;
      setError(errorText(err));
      setPhase("error");
    }
    busy.current = false;
  }, [orderId, method, navigate, phase]);

  // Closed the window but maybe paid (e.g. Instant EFT finishing late): ask the server, never assume.
  const check = async () => {
    if (busy.current) return;
    busy.current = true;
    setPhase("checking");
    try {
      const s = await paymentStatusFn({ data: { orderId } });
      if (!live.current) return;
      if (s?.paid) {
        navigate(returnUrl(orderId, method, "success"));
        return;
      }
      setError(
        "We have not received a confirmed payment for this order yet. If you completed it, it can take a minute — check again shortly. Otherwise pay again below.",
      );
      setPhase("closed");
    } catch {
      if (!live.current) return;
      setError("We could not check the payment just now. Please try again.");
      setPhase("closed");
    }
    busy.current = false;
  };

  const started = useRef(false);
  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true;
      void pay();
    }
  }, [autoStart, pay]);

  const working =
    phase === "starting" ||
    phase === "window" ||
    phase === "checking" ||
    phase === "leaving" ||
    phase === "redirecting";
  const payLabel = amount !== null ? `Pay ${randCents(amount)}` : "Pay now";
  const status =
    phase === "starting"
      ? "Preparing your secure payment…"
      : phase === "window"
        ? "Complete your payment in the secure PayFast window."
        : phase === "checking"
          ? "Checking your payment…"
          : phase === "leaving"
            ? method === "card"
              ? "Taking you to PayFast's secure payment page…"
              : "Taking you to PayPal…"
            : phase === "redirecting"
              ? "Confirming your payment…"
              : phase === "closed"
                ? "The payment window was closed. If you did not finish paying, nothing was charged."
                : "";

  return (
    <section
      aria-labelledby={`pay-${orderId}`}
      className="w-full max-w-md rounded-xl border border-border bg-card p-5 text-left shadow-sm"
      data-testid="payment-panel"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 id={`pay-${orderId}`} className="font-display text-sm font-bold uppercase">
          {method === "card" ? "Secure card payment" : "Pay with PayPal"}
        </h3>
        <span className="flex items-center gap-1 text-[0.65rem] font-semibold uppercase text-primary">
          <ShieldCheck size={13} /> Encrypted
        </span>
      </div>
      <dl className="mb-4 flex flex-col gap-1 text-xs">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Order</dt>
          <dd className="font-semibold">{orderNumber}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Amount due</dt>
          <dd className="font-semibold">{amount !== null ? randCents(amount) : "—"}</dd>
        </div>
      </dl>
      {method === "card" && (
        <ul aria-label="Accepted payment methods" className="mb-4 flex flex-wrap gap-1.5">
          {(onsite
            ? ["Visa", "Mastercard", "Instant EFT", "Masterpass"]
            : ["Visa", "Mastercard", "Instant EFT", "Apple Pay", "Google Pay"]
          ).map((m) => (
            <li
              key={m}
              className="rounded-full border border-border bg-background px-2.5 py-0.5 text-[0.65rem] font-semibold"
            >
              {m}
            </li>
          ))}
        </ul>
      )}

      <p
        role="status"
        aria-live="polite"
        className="mb-3 min-h-[1rem] text-xs text-muted-foreground"
      >
        {working && <Loader2 size={12} className="mr-1 inline animate-spin" aria-hidden />}
        {status}
      </p>
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      <Button
        className="w-full"
        size="lg"
        disabled={working}
        aria-busy={working}
        onClick={() => void pay()}
      >
        {phase === "closed" || phase === "error" ? (
          <RotateCcw size={15} className="mr-1.5" />
        ) : method === "card" ? (
          <CreditCard size={15} className="mr-1.5" />
        ) : (
          <Lock size={15} className="mr-1.5" />
        )}
        {phase === "closed" || phase === "error" ? `Try again · ${payLabel}` : payLabel}
      </Button>
      {phase === "closed" && (
        <Button className="mt-2 w-full" variant="outline" size="sm" onClick={() => void check()}>
          I completed my payment — check status
        </Button>
      )}

      <p className="mt-3 flex items-start gap-1.5 text-[0.7rem] text-muted-foreground">
        <Lock size={12} className="mt-0.5 shrink-0" aria-hidden />
        {method === "card"
          ? onsite
            ? "You pay in PayFast's secure window without leaving Cannaplug. Your card details go straight to PayFast — we never see or store them."
            : "You pay on PayFast's secure page. Your card details go straight to PayFast — we never see or store them."
          : "PayPal charges in US dollars at the rate shown before you pay."}{" "}
        Your order is confirmed only once {method === "card" ? "PayFast" : "PayPal"} verifies the
        payment with us.
      </p>
    </section>
  );
}
