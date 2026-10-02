import { useEffect, useState } from "react";
import { CreditCard, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getOnlineMethodsFn, startPaymentFn } from "@/lib/payments.functions";

/** Lets a member pay an unpaid order online. Paid status only ever comes back from the server after verification. */
export function PayNow({ orderId, hint }: { orderId: string; hint?: string }) {
  const [methods, setMethods] = useState<{ card: boolean; paypal: boolean } | null>(null);
  const [busy, setBusy] = useState<"yoco" | "paypal" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getOnlineMethodsFn()
      .then((m) => live && setMethods(m))
      .catch(() => live && setMethods({ card: false, paypal: false }));
    return () => {
      live = false;
    };
  }, []);
  if (!methods || (!methods.card && !methods.paypal)) return null;

  const pay = async (provider: "yoco" | "paypal") => {
    setBusy(provider);
    setError(null);
    try {
      const s = await startPaymentFn({ data: { orderId, provider, key: crypto.randomUUID() } });
      window.location.assign(s.redirectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "We could not start that payment.");
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-dashed border-border p-3">
      <p className="mb-2 text-[0.65rem] font-bold uppercase text-muted-foreground">Pay now</p>
      <div className="flex flex-wrap gap-2">
        {methods.card && (
          <Button size="sm" disabled={busy !== null} onClick={() => void pay("yoco")}>
            <CreditCard size={13} className="mr-1.5" /> {busy === "yoco" ? "Opening…" : "Card / Instant EFT"}
          </Button>
        )}
        {methods.paypal && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void pay("paypal")}>
            <Lock size={13} className="mr-1.5" /> {busy === "paypal" ? "Opening…" : "PayPal (USD)"}
          </Button>
        )}
      </div>
      {hint && <p className="mt-2 text-[0.7rem] text-muted-foreground">{hint}</p>}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
