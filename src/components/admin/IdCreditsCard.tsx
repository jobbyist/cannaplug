import { useCallback, useEffect, useRef, useState } from "react";
import { Coins, PlusCircle, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QuantityStepper } from "@/components/admin/inventory/QuantityStepper";
import { createKeyStore } from "@/components/admin/pos/pos-logic";
import { getIdCreditsFn, setIdCreditReserveFn, topUpIdCreditsFn } from "@/lib/id-credits.functions";
import type { IdCreditMovement, IdCreditSummary } from "@/lib/id-credits.server";

export type IdCreditsApi = {
  summary: () => Promise<IdCreditSummary>;
  topUp: (input: { credits: number; note: string | null; key: string }) => Promise<unknown>;
  setReserve: (input: { reserved: number; note: string | null; key: string }) => Promise<unknown>;
};

const serverApi: IdCreditsApi = {
  summary: () => getIdCreditsFn() as Promise<IdCreditSummary>,
  topUp: (data) => topUpIdCreditsFn({ data }),
  setReserve: (data) => setIdCreditReserveFn({ data }),
};

const KIND_LABEL: Record<IdCreditMovement["kind"], string> = {
  opening: "Opening balance",
  top_up: "Top-up",
  charge: "New member ID check",
  reserve: "Reserved for imports",
  release: "Reserve released",
  adjustment: "Adjustment",
};

export type CreditHealth = "ok" | "low" | "depleted";
export function creditHealth(
  s: Pick<IdCreditSummary, "available" | "cost_per_check" | "low_balance_threshold">,
): CreditHealth {
  if (s.available < Math.max(s.cost_per_check, 1)) return "depleted";
  if (s.available <= s.low_balance_threshold) return "low";
  return "ok";
}

const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-ZA", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** /admin → ID checks: the credit balance, recent use, and recording a top-up (any staff) or the reserve (admin). */
export function IdCreditsCard({
  canSetReserve,
  api = serverApi,
}: {
  canSetReserve: boolean;
  api?: IdCreditsApi;
}) {
  const [data, setData] = useState<IdCreditSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"topup" | "reserve" | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.summary());
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error)
    return (
      <p
        role="alert"
        className="mb-4 rounded-lg bg-destructive/10 px-4 py-3 text-xs text-destructive"
      >
        ID-check credits: {error}
      </p>
    );
  if (!data) return <p className="mb-4 text-xs text-muted-foreground">Loading ID-check credits…</p>;

  const health = creditHealth(data);
  const recent = showAll ? data.recent : data.recent.slice(0, 5);
  const done = async (message: string) => {
    setNotice(message);
    await load();
  };

  return (
    <section
      className="mb-6 rounded-xl border border-border bg-card p-4"
      aria-label="ID-check credits"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase">
            <Coins size={16} className="text-[#D4AF37]" /> ID-check credits
            <Badge
              variant="outline"
              className={
                health === "ok"
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : health === "low"
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-700"
                    : "border-destructive/30 bg-destructive/10 text-destructive"
              }
            >
              {health === "ok" ? "Healthy" : health === "low" ? "Running low" : "Used up"}
            </Badge>
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Each new member costs {data.cost_per_check} credits, charged once when they first upload
            their ID.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setDialog("topup")}>
            <PlusCircle size={14} /> Record top-up
          </Button>
          {canSetReserve && (
            <Button size="sm" variant="outline" onClick={() => setDialog("reserve")}>
              <Settings2 size={14} /> Reserve
            </Button>
          )}
        </div>
      </div>

      {health !== "ok" && (
        <p
          role="alert"
          className={`mt-3 rounded-lg px-3 py-2 text-xs font-semibold ${health === "depleted" ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-800"}`}
        >
          {health === "depleted"
            ? "New sign-ups and ID uploads are paused until credits are topped up."
            : `${data.low_balance_threshold} credits or fewer left. Top up to avoid service disruption.`}
          {data.low_alert_sent_at &&
            ` Alert emailed to ${data.alert_emails.join(" and ")} on ${when(data.low_alert_sent_at)}.`}
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <p className="text-[0.65rem] font-bold uppercase text-muted-foreground">Available</p>
          <p className="font-display text-2xl font-extrabold" data-testid="credits-available">
            {data.available}
          </p>
          <p className="text-[0.68rem] text-muted-foreground">
            ≈ {data.checks_left ?? 0} new members
          </p>
        </div>
        <div>
          <p className="text-[0.65rem] font-bold uppercase text-muted-foreground">
            Reserved for imports
          </p>
          <p className="font-display text-2xl font-extrabold">{data.reserved}</p>
          <p className="text-[0.68rem] text-muted-foreground">
            {data.reserved_checks_left ?? 0} imported members
          </p>
        </div>
        <div>
          <p className="text-[0.65rem] font-bold uppercase text-muted-foreground">Used, 30 days</p>
          <p className="font-display text-2xl font-extrabold">{data.used_last_30_days}</p>
          <p className="text-[0.68rem] text-muted-foreground">
            {data.charged_members} members in total
          </p>
        </div>
        <div>
          <p className="text-[0.65rem] font-bold uppercase text-muted-foreground">Alert at</p>
          <p className="font-display text-2xl font-extrabold">{data.low_balance_threshold}</p>
          <p className="text-[0.68rem] text-muted-foreground">emails admin@ and info@</p>
        </div>
      </div>

      {notice && (
        <p role="status" className="mt-3 rounded-lg bg-primary/5 px-3 py-2 text-xs text-primary">
          {notice}
        </p>
      )}

      {data.recent.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-[0.65rem] font-bold uppercase text-muted-foreground">
            Recent activity
          </p>
          <ul className="divide-y divide-border text-xs">
            {recent.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="min-w-0 truncate">
                  <b>{KIND_LABEL[m.kind]}</b>
                  {m.note && m.kind !== "charge" ? ` · ${m.note}` : ""}
                  <span className="text-muted-foreground"> · {when(m.created_at)}</span>
                </span>
                <span className="shrink-0 font-semibold">
                  {m.credits !== 0 && (
                    <span className={m.credits < 0 ? "text-destructive" : "text-primary"}>
                      {m.credits > 0 ? "+" : ""}
                      {m.credits}
                    </span>
                  )}
                  {m.reserved_delta !== 0 && (
                    <span className="ml-2 text-muted-foreground">
                      reserve {m.reserved_delta > 0 ? "+" : ""}
                      {m.reserved_delta}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {data.recent.length > 5 && (
            <button
              type="button"
              className="mt-1 text-xs font-semibold text-primary underline"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? "Show less" : `Show all ${data.recent.length}`}
            </button>
          )}
        </div>
      )}

      <TopUpDialog
        open={dialog === "topup"}
        onOpenChange={(o) => !o && setDialog(null)}
        available={data.available}
        api={api}
        onDone={done}
      />
      {canSetReserve && (
        <ReserveDialog
          open={dialog === "reserve"}
          onOpenChange={(o) => !o && setDialog(null)}
          data={data}
          api={api}
          onDone={done}
        />
      )}
    </section>
  );
}

function TopUpDialog({
  open,
  onOpenChange,
  available,
  api,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  available: number;
  api: IdCreditsApi;
  onDone: (m: string) => Promise<void>;
}) {
  const [credits, setCredits] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const keys = useRef(createKeyStore());
  useEffect(() => {
    if (open) {
      setCredits("");
      setNote("");
      setErr(null);
      keys.current.reset();
    }
  }, [open]);
  const n = credits === "" ? 0 : Number(credits);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    const body = { credits: n, note: note.trim() || null };
    try {
      await api.topUp({ ...body, key: keys.current.keyFor(JSON.stringify(body)) });
      keys.current.reset();
      onOpenChange(false);
      await onDone(`Recorded a top-up of ${n} credits.`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record a credit top-up</DialogTitle>
          <DialogDescription>
            Enter the credits you bought. Add the invoice or reference so it can be traced.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Label htmlFor="topup-credits">Credits bought</Label>
          <QuantityStepper
            id="topup-credits"
            label="credits"
            value={credits}
            onChange={setCredits}
            max={100000}
            quick={[50, 100, 200, 500]}
          />
          <Label htmlFor="topup-note">Reference (optional)</Label>
          <Input
            id="topup-note"
            maxLength={200}
            placeholder="e.g. invoice INV-1042"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm" data-testid="topup-preview">
            Available: {available} → <b>{available + n}</b>
          </p>
          {err && (
            <p role="alert" className="text-xs text-destructive">
              {err}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || n < 1} onClick={() => void submit()}>
            {n > 0 ? `Add ${n} credits` : "Add credits"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReserveDialog({
  open,
  onOpenChange,
  data,
  api,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  data: IdCreditSummary;
  api: IdCreditsApi;
  onDone: (m: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const keys = useRef(createKeyStore());
  useEffect(() => {
    if (open) {
      setValue(String(data.reserved));
      setNote("");
      setErr(null);
      keys.current.reset();
    }
  }, [open, data.reserved]);
  const n = value === "" ? 0 : Number(value);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    const body = { reserved: n, note: note.trim() || null };
    try {
      await api.setReserve({ ...body, key: keys.current.keyFor(JSON.stringify(body)) });
      keys.current.reset();
      onOpenChange(false);
      await onDone(`Reserve set to ${n} credits.`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Credits reserved for imported members</DialogTitle>
          <DialogDescription>
            Imported members are charged from this reserve. Release what the import did not use so
            new sign-ups can use it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Label htmlFor="reserve-credits">Reserved credits</Label>
          <QuantityStepper
            id="reserve-credits"
            label="reserved credits"
            value={value}
            onChange={setValue}
            max={Math.max(data.total, 0)}
          />
          <Label htmlFor="reserve-note">Reason (optional)</Label>
          <Input
            id="reserve-note"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm">
            Available for new sign-ups: {data.available} →{" "}
            <b>{data.available - (n - data.reserved)}</b>
          </p>
          {err && (
            <p role="alert" className="text-xs text-destructive">
              {err}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || value === "" || n === data.reserved}
            onClick={() => void submit()}
          >
            Save reserve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
