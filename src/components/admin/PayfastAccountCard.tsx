import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, CheckCircle2, Clock, Info, RefreshCw, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { getPayfastAccountFn } from "@/lib/payfast-account.functions";
import { PAYFAST_FEES } from "@/lib/payments/payfast-account";
import type { PayfastAccountView } from "@/lib/payments/payfast-account.server";

const zar = (v: number) =>
  `${v < 0 ? "-" : ""}R${Math.abs(v).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (d: string) => {
  // PayFast dates are "YYYY-MM-DD HH:MM:SS" in South African time.
  const [day, time] = d.split(" ");
  return `${new Date(`${day}T12:00:00Z`).toLocaleDateString("en-ZA", { day: "numeric", month: "short", timeZone: "UTC" })}${time ? ` ${time.slice(0, 5)}` : ""}`;
};

export type AccountLoader = () => Promise<PayfastAccountView>;
const serverLoad: AccountLoader = () => getPayfastAccountFn() as Promise<PayfastAccountView>;
const REFRESH_MS = 60_000;

/**
 * Live PayFast account for online orders: the balance net of PayFast's fees (from PayFast's Transaction History),
 * the automated daily payout (pending / completed), and PayFast's fees. Refreshes every minute while open.
 */
export function PayfastAccountCard({ load = serverLoad }: { load?: AccountLoader }) {
  const [view, setView] = useState<PayfastAccountView | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const v = await load();
      if (live.current) setView(v);
    } catch {
      if (live.current) setView({ status: "unavailable", fetchedAt: new Date().toISOString() });
    } finally {
      if (live.current) setBusy(false);
    }
  }, [load]);
  useEffect(() => {
    live.current = true;
    void refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => {
      live.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  return (
    <section
      aria-labelledby="pf-account"
      className="rounded-xl border border-border bg-card p-5"
      data-testid="payfast-account"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="pf-account" className="font-display text-sm font-bold uppercase">
          <Wallet size={14} className="mr-1 inline" /> PayFast account (online orders)
        </h2>
        <div className="flex items-center gap-2">
          <FeesDialog />
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Refresh
          </Button>
        </div>
      </div>
      <AccountBody view={view} />
    </section>
  );
}

function AccountBody({ view }: { view: PayfastAccountView | null }) {
  if (!view) return <p className="text-xs text-muted-foreground">Loading PayFast balance…</p>;
  if (view.status === "not_configured")
    return (
      <p className="text-xs text-muted-foreground">
        PayFast is not configured, so there is no PayFast balance to show.
      </p>
    );
  if (view.status === "needs_passphrase")
    return (
      <p role="alert" className="text-xs text-destructive">
        PayFast's API needs the passphrase: set PAYFAST_PASSPHRASE (the same value as PayFast →
        Settings → Developer settings) to show the live balance and payouts.
      </p>
    );
  if (view.status === "unavailable")
    return (
      <p role="alert" className="text-xs text-destructive">
        PayFast's balance is unavailable right now. It will retry automatically every minute. Check
        that API access is enabled on the PayFast account if this persists.
      </p>
    );

  const { next, schedule } = view;
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
          <p className="text-[0.65rem] font-bold uppercase text-muted-foreground">
            Balance (net of PayFast fees)
          </p>
          <p className="mt-1 font-display text-2xl font-extrabold" data-testid="pf-balance">
            {zar(view.balance)}
          </p>
          <p className="text-[0.7rem] text-muted-foreground">
            {view.mode === "sandbox" ? "Sandbox · " : ""}
            {view.balanceAsAt ? `last movement ${when(view.balanceAsAt)} · ` : ""}
            checked{" "}
            {new Date(view.fetchedAt).toLocaleTimeString("en-ZA", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="text-[0.65rem] font-bold uppercase text-muted-foreground">
            Online payments today
          </p>
          <p className="mt-1 font-display text-xl font-extrabold">{zar(view.today.gross)}</p>
          <p className="text-[0.7rem] text-muted-foreground">
            {view.today.count} payments · fees {zar(view.today.fees)} · net {zar(view.today.net)}
          </p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="text-[0.65rem] font-bold uppercase text-muted-foreground">
            Fees since {when(view.period.from)}
          </p>
          <p className="mt-1 font-display text-xl font-extrabold">{zar(view.period.fees)}</p>
          <p className="text-[0.7rem] text-muted-foreground">
            on {zar(view.period.gross)} from {view.period.count} payments · payout fees{" "}
            {zar(view.period.payoutFees)}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 flex items-center gap-1 text-xs font-bold uppercase">
            <CalendarClock size={13} /> Payout schedule
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            Automatic payout to the bank account on PayFast, {schedule.frequency}, once the balance
            reaches {zar(schedule.thresholdRand)}. PayFast charges {zar(schedule.payoutFeeExVat)}{" "}
            excl. VAT per payout.
          </p>
          <div
            role="status"
            className={
              "mb-3 flex items-start gap-2 rounded-lg border p-3 text-xs " +
              (next.status === "pending"
                ? "border-[#D4AF37]/60 bg-[#D4AF37]/10"
                : "border-border bg-muted/40")
            }
            data-testid="pf-next-payout"
          >
            <Clock size={14} className="mt-0.5 shrink-0" />
            {next.status === "pending" ? (
              <span>
                <b>Payout pending:</b> {zar(next.amount)} will be paid out{" "}
                {next.when === "today" ? "in today's automatic run" : "in the next daily run"} (less
                the {zar(next.feeExVat)} + VAT payout fee).
              </span>
            ) : (
              <span>
                <b>No payout due:</b> the balance is {zar(next.short)} below the{" "}
                {zar(next.threshold)} payout threshold.
              </span>
            )}
          </div>
          {view.payouts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No payouts since {when(view.period.from)}.
            </p>
          ) : (
            <ul className="divide-y divide-border text-xs" aria-label="Completed payouts">
              {view.payouts.map((p) => (
                <li key={p.date} className="flex items-center justify-between gap-2 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 size={13} className="text-primary" />
                    Completed · {when(p.date)}
                  </span>
                  <span>
                    <b>{zar(p.amount)}</b>
                    {p.fee ? (
                      <span className="text-muted-foreground"> · fee {zar(p.fee)}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[0.65rem] text-muted-foreground">
            "Completed" means PayFast has paid it out; your bank may take a little longer to show
            it.
          </p>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-bold uppercase">Fees by payment method</h3>
          {view.period.byMethod.length === 0 ? (
            <p className="text-xs text-muted-foreground">No online payments in this period.</p>
          ) : (
            <ul className="divide-y divide-border text-xs">
              {view.period.byMethod.map((m) => (
                <li key={m.method} className="flex justify-between py-1.5">
                  <span>
                    <b>{m.method}</b> · {m.count} payments
                  </span>
                  <span>
                    {zar(m.gross)}{" "}
                    <span className="text-muted-foreground">· fees {zar(m.fees)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mb-2 mt-4 text-xs font-bold uppercase">Latest movements</h3>
          <ul className="divide-y divide-border text-xs">
            {view.recent.map((r, i) => (
              <li key={`${r.date}-${i}`} className="flex justify-between gap-2 py-1.5">
                <span>
                  {when(r.date)} ·{" "}
                  <b className="capitalize">{r.kind === "payment" ? r.method : r.kind}</b>
                  {view.orderNumbers[r.transactionId] && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {view.orderNumbers[r.transactionId]}
                    </span>
                  )}
                </span>
                <span>
                  {zar(r.net)} <span className="text-muted-foreground">· bal {zar(r.balance)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** PayFast's published fees for every method we have switched on, refunds and payouts. */
export function FeesDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <Info size={13} /> PayFast fees
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>PayFast fees</DialogTitle>
          <DialogDescription>
            PayFast's published rates, checked {PAYFAST_FEES.checked}. The balance above already has
            these taken off.
          </DialogDescription>
        </DialogHeader>
        <table className="w-full text-xs">
          <caption className="sr-only">Transaction fees by payment method</caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th className="py-1.5">Payment method</th>
              <th className="py-1.5">Fee (excl. VAT)</th>
              <th className="py-1.5 text-right">On R500</th>
            </tr>
          </thead>
          <tbody>
            {PAYFAST_FEES.methods.map((m) => (
              <tr key={m.method} className="border-b border-border/60">
                <td className="py-1.5 font-semibold">{m.method}</td>
                <td className="py-1.5">{m.fee}</td>
                <td className="py-1.5 text-right">{zar(m.example)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="w-full text-xs">
          <caption className="sr-only">Other PayFast fees</caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th className="py-1.5">Refunds and payouts</th>
              <th className="py-1.5">Fee (excl. VAT)</th>
            </tr>
          </thead>
          <tbody>
            {PAYFAST_FEES.other.map((o) => (
              <tr key={o.item} className="border-b border-border/60">
                <td className="py-1.5 font-semibold">{o.item}</td>
                <td className="py-1.5">{o.fee}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="list-disc pl-4 text-[0.7rem] text-muted-foreground">
          {PAYFAST_FEES.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <a
          href={PAYFAST_FEES.source}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs font-semibold text-primary underline"
        >
          Current fees on payfast.io
        </a>
      </DialogContent>
    </Dialog>
  );
}
