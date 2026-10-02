import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Check, Clock, X } from "lucide-react";
import { Header } from "@/components/CannaPlugHome";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { confirmPayPalReturnFn, paymentStatusFn } from "@/lib/payments.functions";

/**
 * Where providers send the member back to. This page proves NOTHING by itself: the query string is only a
 * hint about which order to look at. "Paid" is shown only when the server reports the order as paid after a
 * verified provider event (or a server-side PayPal capture that PayPal itself confirmed).
 */
export const Route = createFileRoute("/payment/return")({
  validateSearch: (s: Record<string, unknown>) => ({
    order: typeof s["order"] === "string" ? s["order"] : "",
    provider: s["provider"] === "paypal" ? ("paypal" as const) : ("yoco" as const),
    result: typeof s["result"] === "string" ? s["result"] : "",
    // PayPal appends its order id as `token`
    token: typeof s["token"] === "string" ? s["token"] : "",
  }),
  head: () => ({
    meta: [{ title: "Payment | CannaPlug" }, { name: "robots", content: "noindex" }],
  }),
  component: PaymentReturn,
});

type View = Awaited<ReturnType<typeof paymentStatusFn>>;
const POLL_MS = 3000;
const POLL_FOR_MS = 60_000;

function PaymentReturn() {
  const { order, provider, result, token } = Route.useSearch();
  const { user, loading } = useAuth();
  const [view, setView] = useState<View>(null);
  const [timedOut, setTimedOut] = useState(false);
  const captured = useRef(false);

  useEffect(() => {
    if (loading || !user || !order) return;
    let live = true;
    const started = Date.now();
    const tick = async () => {
      try {
        if (provider === "paypal" && token && result !== "cancelled" && !captured.current) {
          captured.current = true;
          await confirmPayPalReturnFn({ data: { token } }); // server-side capture; the verdict is read below
        }
        const v = await paymentStatusFn({ data: { orderId: order } });
        if (!live) return;
        setView(v);
        if (v?.paid || v?.orderStatus === "cancelled") return;
      } catch {
        /* keep polling */
      }
      if (Date.now() - started > POLL_FOR_MS) {
        if (live) setTimedOut(true);
        return;
      }
      setTimeout(() => live && void tick(), POLL_MS);
    };
    void tick();
    return () => {
      live = false;
    };
  }, [loading, user, order, provider, token, result]);

  const paid = view?.paid === true;
  const cancelled = result === "cancelled" || result === "failed";
  return (
    <div className="site">
      <Header />
      <main className="mx-auto flex w-full max-w-[560px] flex-col items-center gap-4 px-4 py-16 text-center">
        {!user && !loading ? (
          <>
            <h1 className="font-display text-xl font-extrabold uppercase">
              Sign in to see your payment
            </h1>
            <Link to="/account">
              <Button size="sm">Sign in</Button>
            </Link>
          </>
        ) : paid ? (
          <>
            <span className="grid h-14 w-14 place-items-center rounded-full bg-primary text-primary-foreground">
              <Check size={26} />
            </span>
            <h1 className="font-display text-xl font-extrabold uppercase">Payment confirmed</h1>
            <p className="text-sm text-muted-foreground">
              Order <b>{view?.orderNumber}</b> is paid and being prepared. We have emailed your
              confirmation.
            </p>
          </>
        ) : view?.orderStatus === "cancelled" ? (
          <>
            <span className="grid h-14 w-14 place-items-center rounded-full bg-destructive/10 text-destructive">
              <X size={26} />
            </span>
            <h1 className="font-display text-xl font-extrabold uppercase">Order cancelled</h1>
            <p className="text-sm text-muted-foreground">This order is no longer active.</p>
          </>
        ) : cancelled && !timedOut ? (
          <>
            <span className="grid h-14 w-14 place-items-center rounded-full bg-destructive/10 text-destructive">
              <X size={26} />
            </span>
            <h1 className="font-display text-xl font-extrabold uppercase">Payment not completed</h1>
            <p className="text-sm text-muted-foreground">
              Nothing was charged. Your order is still reserved for a short time — you can try again
              from your account.
            </p>
          </>
        ) : (
          <>
            <span className="grid h-14 w-14 place-items-center rounded-full bg-muted text-muted-foreground">
              <Clock size={26} />
            </span>
            <h1 className="font-display text-xl font-extrabold uppercase">
              {timedOut ? "Still waiting for confirmation" : "Confirming your payment…"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {timedOut
                ? "Your provider has not confirmed the payment yet. This can take a few minutes — we will email you as soon as it is verified. You do not need to pay again."
                : "We are waiting for the payment provider to confirm. Please keep this page open."}
            </p>
          </>
        )}
        <Link to="/account">
          <Button size="sm" variant="outline">
            View my orders
          </Button>
        </Link>
      </main>
    </div>
  );
}
