import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rand } from "@/lib/cart";
import {
  approveEftFn,
  getPaymentsOverviewFn,
  rejectEftFn,
  setManualFxRateFn,
  updateFxSettingsFn,
} from "@/lib/payments.functions";

type Overview = Awaited<ReturnType<typeof getPaymentsOverviewFn>>;

const money = (amount: number, currency: string) => (currency === "ZAR" ? rand(Number(amount)) : `US$${Number(amount).toFixed(2)}`);
const statusVariant = (s: string) =>
  s === "succeeded" ? "default" : s === "review" || s === "needs_refund" || s === "failed" ? "destructive" : "secondary";
const when = (iso: string) => new Date(iso).toLocaleString("en-ZA", { dateStyle: "short", timeStyle: "short" });

/** Manager-only. Server functions and the database enforce the role; this panel is a convenience. */
export function PaymentsPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [margin, setMargin] = useState("4");
  const [manualRate, setManualRate] = useState("");

  const load = useCallback(async () => {
    try {
      const o = await getPaymentsOverviewFn();
      setData(o);
      setMargin(String(o.settings.fxMarginPercent));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load payments.");
    }
  }, []);
  useEffect(() => void load(), [load]);

  const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    setNote(null);
    try {
      await fn();
      setNote(done);
      await load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  };

  if (error) return <p role="alert" className="text-sm text-destructive">{error} (Payments are visible to managers and admins.)</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading payments…</p>;

  const pending = data.transactions.filter((t) => t.status === "pending_approval");
  const attention = data.transactions.filter((t) => t.status === "review" || t.status === "needs_refund");
  const fx = data.fx;
  const fxLive = fx && new Date(fx.valid_until) > new Date();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-xl font-extrabold uppercase">Payments</h1>
      {note && <p role="status" className="rounded-md bg-muted px-3 py-2 text-xs">{note}</p>}

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4 text-xs">
          <p className="mb-1 font-bold uppercase text-muted-foreground">Providers</p>
          <p>Card / Instant EFT (Yoco): <b>{data.configured.card ? "configured" : "not configured"}</b></p>
          <p>PayPal: <b>{data.configured.paypal ? "configured" : "not configured"}</b></p>
          <p>Refused webhooks (24h): <b>{data.rejectionsLast24h}</b></p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 text-xs sm:col-span-2">
          <p className="mb-1 font-bold uppercase text-muted-foreground">PayPal exchange rate (ZAR per US$1)</p>
          <p>
            {fx ? (
              <>
                <b>R{Number(fx.rate).toFixed(4)}</b> · {fxLive ? "valid until " + when(fx.valid_until) : <span className="text-destructive">expired</span>} · {fx.source}
              </>
            ) : (
              "No rate yet — it is fetched live when a member starts a PayPal payment."
            )}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              Mode
              <select
                className="h-9 rounded-md border border-input bg-background px-2"
                value={data.settings.fxMode}
                onChange={(e) =>
                  void act("fxmode", () => updateFxSettingsFn({ data: { mode: e.target.value as "live" | "manual", marginPercent: Number(margin) } }), "Exchange-rate mode updated.")
                }
              >
                <option value="live">Live market rate</option>
                <option value="manual">Manual only</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Margin %
              <Input className="w-20" inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={busy === "margin" || !(Number(margin) >= 0 && Number(margin) <= 10)}
              onClick={() => void act("margin", () => updateFxSettingsFn({ data: { mode: data.settings.fxMode, marginPercent: Number(margin) } }), "Margin saved.")}
            >
              Save margin
            </Button>
            <label className="flex flex-col gap-1">
              Manual rate
              <Input className="w-24" inputMode="decimal" placeholder="e.g. 17.20" value={manualRate} onChange={(e) => setManualRate(e.target.value)} />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={busy === "rate" || !(Number(manualRate) >= 5 && Number(manualRate) <= 60)}
              onClick={() => void act("rate", () => setManualFxRateFn({ data: { rate: Number(manualRate), validHours: 24 } }), "Manual rate set for 24 hours.")}
            >
              Set for 24h
            </Button>
          </div>
          <p className="mt-2 text-muted-foreground">
            The member is charged slightly more US$ than the market rate suggests (the margin) to cover PayPal&apos;s conversion spread.
          </p>
        </div>
      </section>

      {pending.length > 0 && (
        <section>
          <h2 className="mb-2 font-display text-sm font-bold uppercase">EFT awaiting second approval</h2>
          <div className="flex flex-col gap-2">
            {pending.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-3 text-xs">
                <span>
                  <b>{t.order_number}</b> · {money(t.expected_amount, t.expected_currency)} · ref {t.provider_ref} · {when(t.created_at)}
                </span>
                <span className="flex gap-2">
                  <Button size="sm" disabled={busy === t.id} onClick={() => void act(t.id, () => approveEftFn({ data: { transactionId: t.id } }), "EFT approved.")}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === t.id}
                    onClick={() => {
                      const reason = window.prompt("Reason for rejecting this EFT?");
                      if (reason && reason.trim().length >= 3)
                        void act(t.id, () => rejectEftFn({ data: { transactionId: t.id, reason: reason.trim() } }), "EFT rejected.");
                    }}
                  >
                    Reject
                  </Button>
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[0.7rem] text-muted-foreground">You cannot approve an EFT you recorded yourself (dual control from R{data.settings.eftThreshold.toLocaleString("en-ZA")}).</p>
        </section>
      )}

      {attention.length > 0 && (
        <section>
          <h2 className="mb-2 font-display text-sm font-bold uppercase text-destructive">Needs attention</h2>
          <ul className="flex flex-col gap-2 text-xs">
            {attention.map((t) => (
              <li key={t.id} className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
                <b>{t.order_number}</b> · {t.provider} · {money(t.expected_amount, t.expected_currency)} ·{" "}
                <Badge variant="destructive">{t.status.replace("_", " ")}</Badge> · {t.failure_reason ?? ""}
                {t.received_amount != null && <> · received {money(t.received_amount, t.received_currency ?? t.expected_currency)}</>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 font-display text-sm font-bold uppercase">Recent payment attempts</h2>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="p-2">When</th><th className="p-2">Order</th><th className="p-2">Method</th><th className="p-2">Mode</th><th className="p-2">Expected</th><th className="p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className="p-2">{when(t.created_at)}</td>
                  <td className="p-2 font-semibold">{t.order_number}</td>
                  <td className="p-2">{t.provider}</td>
                  <td className="p-2">{t.mode}</td>
                  <td className="p-2">{money(t.expected_amount, t.expected_currency)}</td>
                  <td className="p-2"><Badge variant={statusVariant(t.status)}>{t.status.replace("_", " ")}</Badge></td>
                </tr>
              ))}
              {data.transactions.length === 0 && (
                <tr><td className="p-3 text-muted-foreground" colSpan={6}>No payment attempts yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
