import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setEftDetailsFn } from "@/lib/payments.functions";
import type { EftDetails } from "@/lib/payments/eft";
import { eftDraftValid, type Draft } from "@/components/admin/eft-draft";

const empty: Draft = {
  bank: "",
  account_holder: "",
  account_type: "",
  account_number: "",
  branch_code: "",
};
const FIELDS: [keyof Draft, string, string][] = [
  ["bank", "Bank", "e.g. FNB"],
  ["account_holder", "Account holder", "e.g. Cannaplug (Pty) Ltd"],
  ["account_type", "Account type (optional)", "e.g. Business cheque"],
  ["account_number", "Account number", "digits only"],
  ["branch_code", "Branch code", "6 digits"],
];

/**
 * Manager-only. Members are offered "Bank transfer (EFT)" only once these details are saved here AND the
 * manager ticks that the owner has confirmed them. Clearing them hides EFT at checkout straight away.
 */
export function EftDetailsCard({
  current,
  onSaved,
}: {
  current: EftDetails | null;
  onSaved: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(empty);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(current ? { ...current, account_type: current.account_type ?? "" } : empty);
    setConfirmed(false);
  }, [current]);

  const save = async (details: Draft | null) => {
    setBusy(true);
    setError(null);
    try {
      await setEftDetailsFn({
        data: {
          details: details
            ? {
                bank: details.bank,
                account_holder: details.account_holder,
                account_type: details.account_type.trim() || null,
                account_number: details.account_number,
                branch_code: details.branch_code,
                confirmed: true as const,
              }
            : null,
          key: crypto.randomUUID(),
        },
      });
      onSaved(
        details
          ? "Bank details saved. Members can now choose Bank transfer (EFT)."
          : "EFT switched off.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the bank details.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4 text-xs">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-bold uppercase text-muted-foreground">Bank transfer (EFT) details</p>
        <span
          className={
            "rounded-full px-2 py-0.5 font-semibold " +
            (current ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")
          }
        >
          {current ? "Shown at checkout" : "Hidden — EFT not offered"}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {FIELDS.map(([k, label, placeholder]) => (
          <label key={k} className="flex flex-col gap-1">
            {label}
            <Input
              value={draft[k]}
              placeholder={placeholder}
              inputMode={k === "account_number" || k === "branch_code" ? "numeric" : undefined}
              onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <label className="mt-3 flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 accent-primary"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <span>
          The owner has confirmed these are the shop&apos;s correct bank details. Members will pay
          into this account using their order number as the reference.
        </span>
      </label>
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !confirmed || !eftDraftValid(draft)}
          onClick={() => void save(draft)}
        >
          {busy ? "Saving…" : "Save and show at checkout"}
        </Button>
        {current && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void save(null)}>
            Switch EFT off
          </Button>
        )}
      </div>
    </section>
  );
}
