import { useRef, useState } from "react";
import { Landmark, Plus, Receipt, Trash2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rand } from "@/lib/cart";
import { addPosExpenseFn, closePosSessionFn, voidPosExpenseFn } from "@/lib/pos.functions";
import { centsToAmount, createKeyStore, parseCents } from "./pos-logic";
import { EXPENSE_CATEGORY_LABELS, cashupLines, reconciles, type CloseResult } from "./cashup-logic";

const cardClass = "rounded-xl border border-border bg-card p-5";
const headingClass = "font-display text-sm font-bold uppercase";
const errorClass =
  "rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive";
const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";
const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please retry.";

export type SessionCashup = {
  expenses: {
    id: string;
    amount: number;
    category: string;
    description: string;
    created_at: string;
    mine: boolean;
  }[];
  expensesTotal: number;
  discountsTotal: number;
};

/** Cash paid out of the till during the day. Recorded as it happens so the close can reconcile. */
export function TillExpenses({
  sessionId,
  cashup,
  isManager,
  onChanged,
}: {
  sessionId: string;
  cashup: SessionCashup | null;
  isManager: boolean;
  onChanged: () => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("supplies");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(createKeyStore());

  const add = async () => {
    const cents = parseCents(amount);
    if (cents === null || cents <= 0) return setError("Enter the amount paid out, e.g. 45.50.");
    if (description.trim().length < 3) return setError("Say what the money was spent on.");
    setBusy(true);
    setError(null);
    try {
      const a = centsToAmount(cents);
      await addPosExpenseFn({
        data: {
          sessionId,
          amount: a,
          category: category as "supplies",
          description: description.trim(),
          key: keys.current.keyFor(`${sessionId}:${a}:${category}:${description.trim()}`),
        },
      });
      keys.current.reset();
      setAmount("");
      setDescription("");
      await onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const reason = window.prompt("Why remove this expense? (at least 3 characters)");
    if (!reason || reason.trim().length < 3) return;
    setError(null);
    try {
      await voidPosExpenseFn({
        data: { expenseId: id, reason: reason.trim(), key: `void-${id}-${Date.now()}` },
      });
      await onChanged();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const list = cashup?.expenses ?? [];
  return (
    <div className={cardClass} data-testid="till-expenses">
      <h2 className={`mb-1 ${headingClass}`}>
        <Receipt size={14} className="mr-1 inline" /> Till expenses
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Record cash taken from the till for store expenses as it happens (keep the slip). It is
        deducted from the cash expected at close. Do not enter customer names, ID or health details.
      </p>
      {list.length > 0 && (
        <ul className="mb-3 grid gap-1 text-xs">
          {list.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
            >
              <span>
                <b>{EXPENSE_CATEGORY_LABELS[e.category] ?? e.category}</b> · {e.description}
              </span>
              <span className="flex items-center gap-2">
                <b>{rand(e.amount)}</b>
                {(e.mine || isManager) && (
                  <button
                    type="button"
                    aria-label={`Remove expense ${e.description}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => void remove(e.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </span>
            </li>
          ))}
          <li className="flex justify-between px-3 pt-1 font-semibold">
            <span>Total paid out</span>
            <span>{rand(cashup?.expensesTotal ?? 0)}</span>
          </li>
        </ul>
      )}
      <div className="grid gap-2 sm:grid-cols-[120px_160px_1fr_auto]">
        <label className="grid gap-1 text-xs font-semibold">
          Amount (R)
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-semibold">
          Category
          <select
            className={selectClass}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {Object.entries(EXPENSE_CATEGORY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold">
          What for
          <Input
            value={description}
            maxLength={200}
            placeholder="e.g. Cleaning materials from Spar"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <Button className="self-end" disabled={busy} onClick={() => void add()}>
          <Plus size={14} /> Add
        </Button>
      </div>
      {error && <div className={`mt-3 ${errorClass}`}>{error}</div>}
    </div>
  );
}

/**
 * Close the till: blind count first (expected cash is only revealed after), plus the cash taken out for the bank
 * deposit. The database works out the reconciliation and fixes it; this shows it line by line.
 */
export function CloseTill({
  session,
  cashup,
  onChanged,
}: {
  session: { id: string; opening_float: number };
  cashup: SessionCashup | null;
  onChanged: () => Promise<void>;
}) {
  const [counted, setCounted] = useState("");
  const [deposit, setDeposit] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CloseResult | null>(null);
  const keys = useRef(createKeyStore());

  const countedCents = parseCents(counted);
  const depositCents = deposit.trim() === "" ? 0 : parseCents(deposit);
  const floatLeft =
    countedCents !== null && depositCents !== null ? countedCents - depositCents : null;

  const close = async () => {
    if (countedCents === null) return setError("Enter the counted cash as a valid amount.");
    if (depositCents === null) return setError("Enter the deposit as a valid amount (or 0).");
    if (depositCents > countedCents)
      return setError("The deposit cannot be more than the cash counted.");
    setBusy(true);
    setError(null);
    try {
      const a = centsToAmount(countedCents);
      const d = centsToAmount(depositCents);
      const r = (await closePosSessionFn({
        data: {
          sessionId: session.id,
          actualCash: a,
          cashDeposited: d,
          ...(note.trim() ? { note: note.trim() } : {}),
          key: keys.current.keyFor(`${session.id}:${a}:${d}:${note}`),
        },
      })) as CloseResult;
      setResult(r);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const variance = Number(result.variance);
    return (
      <div className={cardClass} role="status" data-testid="till-closed">
        <h2 className={`mb-3 ${headingClass}`}>Till closed — cash-up</h2>
        <dl className="grid max-w-md gap-y-1 text-sm">
          {cashupLines(result).map((l) => (
            <div
              key={l.label}
              className={
                "flex justify-between gap-4 " +
                (l.kind === "=" ? "border-t border-border pt-1 " : "") +
                (l.kind === "i" ? "text-muted-foreground " : "")
              }
            >
              <dt className={l.emphasis ? "font-semibold" : "text-muted-foreground"}>
                {l.kind === "-" ? "− " : l.kind === "+" ? "+ " : ""}
                {l.label}
              </dt>
              <dd
                className={
                  "text-right " +
                  (l.emphasis ? "font-bold " : "font-semibold ") +
                  (l.label.startsWith("Variance") && variance !== 0 ? "text-destructive" : "")
                }
              >
                {rand(l.amount)}
              </dd>
            </div>
          ))}
        </dl>
        {!reconciles(result) && (
          <p className={`mt-2 ${errorClass}`}>
            These figures do not add up. Please report this to a manager.
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {result.approval_status === "pending"
            ? "The variance is outside tolerance and needs a manager's approval with a reason."
            : "Within tolerance — no approval needed."}{" "}
          Bank the deposit and leave the float of {rand(Number(result.float_carried))} in the
          drawer; it will be suggested as the next opening float.
        </p>
        <Button className="mt-3" size="sm" onClick={() => void onChanged()}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className={`${cardClass} max-w-2xl`} data-testid="close-till">
      <h2 className={`mb-1 ${headingClass}`}>
        <Wallet size={14} className="mr-1 inline" /> Close till
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Before closing, make sure every expense paid from the till is recorded above and every
        discount was given through the till. Then count all the cash in the drawer (including the
        float). Expected cash is revealed after you submit the count.
      </p>
      <dl className="mb-3 grid max-w-sm grid-cols-2 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Opening float</dt>
        <dd className="text-right font-semibold">{rand(session.opening_float)}</dd>
        <dt className="text-muted-foreground">Till expenses recorded</dt>
        <dd className="text-right font-semibold">{rand(cashup?.expensesTotal ?? 0)}</dd>
        <dt className="text-muted-foreground">Discounts given at the till</dt>
        <dd className="text-right font-semibold">{rand(cashup?.discountsTotal ?? 0)}</dd>
      </dl>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1.5 text-xs font-semibold">
          Counted cash (R)
          <Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold">
          <span>
            <Landmark size={12} className="mr-1 inline" /> Cash for bank deposit (R)
          </span>
          <Input
            inputMode="decimal"
            placeholder="0.00"
            value={deposit}
            onChange={(e) => setDeposit(e.target.value)}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold">
          Note (optional)
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
        {floatLeft !== null && floatLeft >= 0
          ? `Float left in the drawer for the next session: ${rand(floatLeft / 100)}`
          : floatLeft !== null
            ? "The deposit cannot be more than the cash counted."
            : "The cash left after the deposit becomes the next session's opening float."}
      </p>
      {error && <div className={`mt-3 ${errorClass}`}>{error}</div>}
      <Button
        className="mt-3"
        variant="outline"
        disabled={busy || counted.trim() === "" || (floatLeft !== null && floatLeft < 0)}
        onClick={() => void close()}
      >
        Close till
      </Button>
    </div>
  );
}
