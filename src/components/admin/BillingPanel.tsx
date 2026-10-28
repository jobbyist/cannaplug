import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  ExternalLink,
  Link2,
  Pause,
  Play,
  Settings2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { atLeast, type StaffRole } from "@/lib/admin-nav";
import { notifyAdminTabs } from "@/lib/admin-sync";
import {
  DEACTIVATE_WARNING,
  DOMAIN_MANAGE_MESSAGE,
  VERIFYNOW_PAYFAST as VN,
  daysUntil,
  dueLabel,
  formatDay,
  formatMoney,
  isPaidStatus,
  nextBillingDate,
  todaySast,
  type BillingAccount,
  type BillingPaymentRow,
  type BillingStatus,
} from "@/lib/billing";
import { listBillingFn, setBillingLinkFn, setBillingStatusFn } from "@/lib/billing.functions";

type Data = { accounts: BillingAccount[]; payments: BillingPaymentRow[] };
type Change = { account: BillingAccount; to: "paused" | "cancelled" | "active" };

const LOGOS: Record<string, string> = {
  whatsapp: "/billing/meta-whatsapp.png",
  "email-push": "/billing/resend.png",
  "supabase-platform": "/billing/supabase.png",
  "godaddy-domain": "/billing/godaddy.png",
  "shopify-admin-api": "/billing/shopify.png",
  "payfast-gateway": "/billing/payfast.png",
  "verifynow-id": "/billing/verifynow.png",
};

const STATUS_LABEL: Record<BillingStatus, string> = {
  active: "Active",
  paused: "Paused",
  cancelled: "Cancelled",
  pending: "Pending activation",
};
const STATUS_CLASS: Record<BillingStatus, string> = {
  active: "border-transparent bg-primary/15 text-primary",
  paused: "border-transparent bg-accent/25 text-foreground",
  cancelled: "border-transparent bg-destructive/10 text-destructive",
  pending: "border-transparent bg-muted text-muted-foreground",
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const when = (iso: string) => formatDay(todaySast(new Date(iso)));

function AccountLogo({ account }: { account: BillingAccount }) {
  const src = LOGOS[account.slug];
  return (
    <div className="grid h-14 w-28 shrink-0 place-items-center rounded-lg border border-border bg-white p-1.5">
      {src ? (
        <img src={src} alt={account.provider} className="max-h-11 max-w-[6.25rem] object-contain" />
      ) : (
        <span className="text-center text-[0.65rem] font-bold leading-tight text-muted-foreground">
          {account.provider}
        </span>
      )}
    </div>
  );
}

/** Payfast "Pay Now" button for ID Verification credits (VerifyNow). The admin chooses the amount. */
function VerifyNowPayForm({ disabled }: { disabled: boolean }) {
  return (
    <form
      name="PayFastPayNowForm"
      action={VN.action}
      method="post"
      className="grid gap-2"
      aria-label="Pay VerifyNow with Payfast"
    >
      <input type="hidden" name="cmd" value="_paynow" />
      <input type="hidden" name="receiver" value={VN.receiver} />
      <input type="hidden" name="return_url" value={VN.returnUrl} />
      <input type="hidden" name="cancel_url" value={VN.cancelUrl} />
      <input type="hidden" name="notify_url" value={VN.notifyUrl} />
      <input type="hidden" name="item_name" maxLength={255} value={VN.itemName} />
      <input type="hidden" name="item_description" maxLength={255} value={VN.itemDescription} />
      <label className="grid gap-1 text-xs font-semibold" htmlFor="PayFastAmount">
        Amount (R)
        <Input
          id="PayFastAmount"
          type="number"
          step=".01"
          name="amount"
          min={VN.minAmount}
          placeholder={VN.minAmount}
          defaultValue={VN.defaultAmount}
          required
          disabled={disabled}
          className="max-w-40"
        />
      </label>
      <input
        type="image"
        src={VN.buttonImage}
        alt="Pay Now"
        title="Pay Now with Payfast"
        disabled={disabled}
        className={`h-auto w-40 ${disabled ? "cursor-not-allowed opacity-40 grayscale" : ""}`}
      />
    </form>
  );
}

function PayControl({ account, onManage }: { account: BillingAccount; onManage: () => void }) {
  const off = account.status === "paused" || account.status === "cancelled";
  if (account.payment_kind === "payfast_form") return <VerifyNowPayForm disabled={off} />;
  if (account.payment_kind === "manage")
    return (
      <Button size="sm" variant="outline" onClick={onManage}>
        <Settings2 size={14} /> Manage
      </Button>
    );
  if (account.payment_kind === "link" && account.payment_url) {
    if (off)
      return (
        <Button size="sm" disabled title="Resume this account to pay">
          Pay now
        </Button>
      );
    return (
      <Button asChild size="sm">
        <a href={account.payment_url} target="_blank" rel="noopener noreferrer">
          Pay now <ExternalLink size={14} />
        </a>
      </Button>
    );
  }
  if (account.payment_note)
    return (
      <Button size="sm" disabled>
        {account.payment_note}
      </Button>
    );
  return <span className="text-xs text-muted-foreground">No payment needed</span>;
}

/** Admins and managers track, pay, pause and cancel the recurring service costs. */
export function BillingPanel({ role }: { role: StaffRole | null }) {
  const qc = useQueryClient();
  const isAdmin = atLeast(role, "admin");
  const q = useQuery<Data>({ queryKey: ["admin", "billing"], queryFn: () => listBillingFn() });
  const [change, setChange] = useState<Change | null>(null);
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState("");
  const [linkFor, setLinkFor] = useState<BillingAccount | null>(null);
  const [manage, setManage] = useState<BillingAccount | null>(null);
  const [paypal, setPaypal] = useState<string | null>(null);
  const today = todaySast();
  const [linkUrl, setLinkUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    // Back from PayPal: /admin?paypal=pending#billing (or cancelled).
    const v = new URLSearchParams(window.location.search).get("paypal");
    setPaypal(v === "pending" || v === "cancelled" ? v : null);
  }, []);
  const keys = useRef(new Map<string, string>());
  const keyFor = (k: string) => {
    if (!keys.current.has(k)) keys.current.set(k, crypto.randomUUID());
    return keys.current.get(k)!;
  };

  const status = useMutation({
    mutationFn: (v: { c: Change; reason: string }) =>
      setBillingStatusFn({
        data: {
          slug: v.c.account.slug,
          status: v.c.to,
          reason: v.reason || null,
          key: keyFor(`${v.c.account.slug}:${v.c.to}:${v.reason}`),
        },
      }),
    onSuccess: async (r, v) => {
      keys.current.clear();
      setError(null);
      setMessage(
        r.changed
          ? `${v.c.account.name} is now ${STATUS_LABEL[v.c.to].toLowerCase()}. The developer has been emailed to action it with the provider.`
          : `${v.c.account.name} was already ${STATUS_LABEL[v.c.to].toLowerCase()}.`,
      );
      setChange(null);
      await qc.invalidateQueries({ queryKey: ["admin", "billing"] });
      notifyAdminTabs("any");
    },
    onError: (e) => {
      setMessage(null);
      setError(errMsg(e));
      setChange(null);
    },
  });

  const link = useMutation({
    mutationFn: (v: { slug: string; url: string }) =>
      setBillingLinkFn({
        data: { slug: v.slug, url: v.url || null, key: keyFor(`link:${v.slug}:${v.url}`) },
      }),
    onSuccess: async () => {
      keys.current.clear();
      setError(null);
      setMessage("Payment link saved.");
      setLinkFor(null);
      await qc.invalidateQueries({ queryKey: ["admin", "billing"] });
    },
    onError: (e) => {
      setMessage(null);
      setError(errMsg(e));
    },
  });

  const open = (account: BillingAccount, to: Change["to"]) => {
    setAck(false);
    setReason("");
    setError(null);
    setMessage(null);
    setChange({ account, to });
  };
  const deactivating = change && change.to !== "active";
  const lastPaid = (id: string) =>
    q.data?.payments.find((p) => p.account_id === id && isPaidStatus(p.status));
  const nextDue = (a: BillingAccount) => (a.status === "active" ? nextBillingDate(a, today) : null);
  const dueTomorrow = (q.data?.accounts ?? []).filter((a) => {
    const d = nextDue(a);
    return d !== null && daysUntil(d, today) === 1;
  });
  const nameOf = (id: string) => q.data?.accounts.find((a) => a.id === id)?.name ?? "Service";

  return (
    <div className="grid gap-5">
      <h1 className="font-display text-xl font-extrabold uppercase">Billing</h1>
      <p className="text-xs text-muted-foreground">
        Track, pay and manage the fixed recurring costs for Cannaplug's service providers. Pausing
        or cancelling here is recorded and emailed to the developer; it does not change anything at
        the provider.
      </p>
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-md bg-primary/10 px-3 py-2 text-xs">
          {message}
        </p>
      )}

      {paypal === "pending" && (
        <p role="status" className="rounded-md bg-primary/10 px-3 py-2 text-xs">
          Thanks, your PayPal subscription is being confirmed. The payment appears in the billing
          history below once PayPal confirms it.
        </p>
      )}
      {paypal === "cancelled" && (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-xs">
          The PayPal subscription was cancelled before it was approved. Nothing was charged.
        </p>
      )}
      {dueTomorrow.length > 0 && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md bg-accent/25 px-3 py-2 text-xs font-semibold"
        >
          <CalendarClock size={14} className="mt-0.5 shrink-0" />
          Due tomorrow: {dueTomorrow.map((a) => a.name).join(", ")}
        </p>
      )}
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading billing accounts…</p>}
      {q.isError && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {errMsg(q.error)}
        </p>
      )}

      <ul className="grid gap-4 lg:grid-cols-2">
        {q.data?.accounts.map((a) => {
          const paid = lastPaid(a.id);
          const next = nextDue(a);
          const canChange = a.status !== "pending";
          return (
            <li
              key={a.id}
              data-testid={`billing-${a.slug}`}
              className="grid grid-rows-[auto_1fr_auto] gap-4 rounded-xl border border-border bg-card p-4 sm:p-5"
            >
              <div className="flex items-start gap-3">
                <AccountLogo account={a} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-display text-sm font-bold uppercase leading-tight">
                      {a.name}
                    </h2>
                    <Badge className={STATUS_CLASS[a.status]}>{STATUS_LABEL[a.status]}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {a.beneficiary || a.provider}
                  </p>
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                <div>
                  <dt className="font-semibold text-muted-foreground">Amount</dt>
                  <dd className="mt-0.5 font-semibold">{a.amount_text || "—"}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-muted-foreground">Billing schedule</dt>
                  <dd className="mt-0.5">{a.schedule_text || "—"}</dd>
                </div>
                {next && (
                  <div className="col-span-2">
                    <dt className="font-semibold text-muted-foreground">Next billing</dt>
                    <dd className="mt-0.5 flex flex-wrap items-center gap-2">
                      <span data-testid={`next-${a.slug}`}>
                        {formatDay(next)} ({dueLabel(daysUntil(next, today))})
                      </span>
                      {daysUntil(next, today) === 1 && (
                        <Badge className="border-transparent bg-accent/30 text-foreground">
                          Due tomorrow
                        </Badge>
                      )}
                    </dd>
                  </div>
                )}
                {paid && (
                  <div className="col-span-2">
                    <dt className="font-semibold text-muted-foreground">Last confirmed payment</dt>
                    <dd className="mt-0.5">
                      {formatMoney(paid.amount_cents, paid.currency)} on {when(paid.created_at)}
                    </dd>
                  </div>
                )}
                {a.status_reason && a.status !== "active" && (
                  <div className="col-span-2">
                    <dt className="font-semibold text-muted-foreground">Reason</dt>
                    <dd className="mt-0.5">{a.status_reason}</dd>
                  </div>
                )}
              </dl>

              <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-3">
                <PayControl account={a} onManage={() => setManage(a)} />
                <div className="flex flex-wrap gap-2">
                  {isAdmin && a.payment_kind !== "payfast_form" && a.payment_kind !== "manage" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setLinkUrl(a.payment_url ?? "");
                        setError(null);
                        setLinkFor(a);
                      }}
                    >
                      <Link2 size={14} /> Link
                    </Button>
                  )}
                  {canChange && a.payment_kind !== "manage" && a.status === "active" && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => open(a, "paused")}>
                        <Pause size={14} /> Pause
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => open(a, "cancelled")}>
                        <XCircle size={14} /> Cancel
                      </Button>
                    </>
                  )}
                  {canChange && a.payment_kind !== "manage" && a.status === "paused" && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => open(a, "active")}>
                        <Play size={14} /> Resume
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => open(a, "cancelled")}>
                        <XCircle size={14} /> Cancel
                      </Button>
                    </>
                  )}
                  {canChange && a.payment_kind !== "manage" && a.status === "cancelled" && (
                    <Button size="sm" variant="outline" onClick={() => open(a, "active")}>
                      <Play size={14} /> Reactivate
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <section
        className="rounded-xl border border-border bg-card p-4 sm:p-5"
        aria-label="Billing history"
      >
        <h2 className="mb-3 font-display text-sm font-bold uppercase">Billing history</h2>
        {q.data && q.data.payments.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No payments yet. Payments appear here once Payfast or PayPal confirms them.
          </p>
        )}
        {q.data && q.data.payments.length > 0 && (
          <ul className="divide-y divide-border text-xs">
            {q.data.payments.slice(0, 25).map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2"
              >
                <span className="min-w-0 flex-1 font-semibold">{nameOf(p.account_id)}</span>
                <span className="text-muted-foreground">
                  {when(p.created_at)} · {p.provider === "paypal" ? "PayPal" : "Payfast"}
                </span>
                <span className="font-semibold">{formatMoney(p.amount_cents, p.currency)}</span>
                <Badge
                  className={isPaidStatus(p.status) ? STATUS_CLASS.active : STATUS_CLASS.paused}
                >
                  {isPaidStatus(p.status) ? "Paid" : p.status.toLowerCase()}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={!!manage} onOpenChange={(v) => !v && setManage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{manage?.name}</DialogTitle>
            <DialogDescription>{DOMAIN_MANAGE_MESSAGE}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setManage(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!change} onOpenChange={(v) => !v && setChange(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {deactivating && <TriangleAlert size={18} className="text-destructive" />}
              {change?.to === "paused" && "Pause billing?"}
              {change?.to === "cancelled" && "Cancel billing?"}
              {change?.to === "active" && "Resume billing?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {change?.account.name}
              {deactivating ? ` (${change?.account.provider})` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deactivating ? (
            <div className="grid gap-3 text-sm">
              <p role="alert" className="rounded-md bg-destructive/10 p-3 text-destructive">
                {DEACTIVATE_WARNING}
              </p>
              <label className="grid gap-1 text-xs font-semibold">
                Reason (optional)
                <Input
                  value={reason}
                  maxLength={300}
                  placeholder="Why is this being changed?"
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <label className="flex items-start gap-2 text-xs">
                <Checkbox
                  checked={ack}
                  onCheckedChange={(v) => setAck(v === true)}
                  className="mt-0.5"
                />
                <span>I have confirmed this with my developer or account manager.</span>
              </label>
            </div>
          ) : (
            <p className="text-sm">
              The developer will be emailed so the service can be switched back on.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep as is</AlertDialogCancel>
            <Button
              variant={deactivating ? "destructive" : "default"}
              disabled={status.isPending || (!!deactivating && !ack)}
              onClick={() => change && status.mutate({ c: change, reason: reason.trim() })}
            >
              {change?.to === "paused" && "Pause billing"}
              {change?.to === "cancelled" && "Cancel billing"}
              {change?.to === "active" && "Resume billing"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!linkFor} onOpenChange={(v) => !v && setLinkFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Payment link</DialogTitle>
            <DialogDescription>
              {linkFor?.name}. Use a Payfast, PayPal or Cannaplug https link. Leave empty to remove
              it.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="url"
            value={linkUrl}
            placeholder="https://"
            aria-label="Payment link"
            onChange={(e) => setLinkUrl(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={link.isPending}
              onClick={() => linkFor && link.mutate({ slug: linkFor.slug, url: linkUrl.trim() })}
            >
              Save link
            </Button>
          </DialogFooter>
          {error && linkFor && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
