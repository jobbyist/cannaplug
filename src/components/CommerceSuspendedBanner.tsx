import { useState } from "react";
import { Button } from "@/components/ui/button";
import { resumeCommerceFn } from "@/lib/commerce.functions";

export function CommerceSuspendedBanner({
  kind,
  canResume = false,
  onResumed,
}: {
  kind: "checkout" | "pos";
  /** POS only: shows the admin's manual "Resume now" (the server checks the role again). */
  canResume?: boolean;
  onResumed?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = async () => {
    setBusy(true);
    setError(null);
    try {
      await resumeCommerceFn({
        data: { reason: "Bill settled; resumed by an admin", key: crypto.randomUUID() },
      });
      onResumed?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resume. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="alert"
      data-testid="commerce-suspended"
      className="rounded-xl border border-accent/60 bg-accent/10 px-4 py-3 text-sm"
    >
      <p className="font-display font-extrabold uppercase">
        {kind === "pos" ? "Point of sale paused" : "Online checkout paused"}
      </p>
      <p className="mt-1 text-muted-foreground">
        {kind === "pos"
          ? "Sales are paused while the platform bill is settled. Refunds and voids still work, and sales resume automatically once the payment is received."
          : "Online checkout is temporarily unavailable. Please check back soon, or visit us in store."}
      </p>
      {canResume && (
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          disabled={busy}
          onClick={() => void resume()}
        >
          {busy ? "Resuming…" : "Resume now (admin)"}
        </Button>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
