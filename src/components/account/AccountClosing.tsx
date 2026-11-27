import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { AccountLifecycle } from "@/hooks/useAccountLifecycle";
import {
  DEACTIVATE_EXPLAINER,
  DELETE_EXPLAINER,
  closeBlockedReason,
  type AccountAction,
  type AccountState,
} from "@/lib/account-lifecycle";

/** Shown at the top of the Account page while the account is deactivated or waiting to be deleted. */
export function AccountStatusBanner({ life }: { life: AccountLifecycle }) {
  const s = life.state?.status;
  if (s !== "deactivated" && s !== "deletion_requested") return null;
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold/50 bg-gold/10 px-3 py-2 text-sm"
    >
      <p>
        {s === "deletion_requested"
          ? "You asked us to delete your account. Our team will complete it. Changed your mind? Reactivate now to cancel."
          : "Your account is deactivated. You can't place orders until you reactivate it."}
      </p>
      <Button size="sm" disabled={life.busy} onClick={() => void life.act("reactivate")}>
        Reactivate account
      </Button>
    </div>
  );
}

/** Account settings: deactivate for a while, or ask for the account to be deleted. */
export function AccountClosingCard({ life }: { life: AccountLifecycle }) {
  const [confirm, setConfirm] = useState<null | "deactivate" | "delete">(null);
  const [typed, setTyped] = useState("");
  const { state } = life;

  useEffect(() => {
    if (!confirm) setTyped("");
  }, [confirm]);

  if (!state) return null;
  const blocked = closeBlockedReason(state);
  const closed = state.status === "deactivated" || state.status === "deletion_requested";

  const run = async (action: AccountAction) => {
    if (await life.act(action)) setConfirm(null);
  };

  return (
    <div className="grid gap-3" aria-labelledby="close-account-title">
      <h3 id="close-account-title" className="font-display text-sm font-bold uppercase">
        Close your account
      </h3>
      {closed ? (
        <>
          <p className="text-sm text-muted-foreground">
            {state.status === "deletion_requested"
              ? "Deletion requested. Our team will complete it. Reactivate to cancel."
              : "Your account is deactivated."}
          </p>
          <div>
            <Button size="sm" disabled={life.busy} onClick={() => void life.act("reactivate")}>
              Reactivate account
            </Button>
          </div>
        </>
      ) : (
        <>
          {blocked && (
            <p role="note" className="text-xs text-muted-foreground">
              {blocked}
            </p>
          )}
          <div className="grid gap-2 rounded-lg border border-border p-3">
            <p className="text-sm font-medium">Deactivate temporarily</p>
            <p className="text-xs text-muted-foreground">{DEACTIVATE_EXPLAINER}</p>
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={life.busy || Boolean(blocked)}
                onClick={() => setConfirm("deactivate")}
              >
                Deactivate my account
              </Button>
            </div>
          </div>
          <div className="grid gap-2 rounded-lg border border-destructive/40 p-3">
            <p className="text-sm font-medium text-destructive">Delete my account</p>
            <p className="text-xs text-muted-foreground">{DELETE_EXPLAINER}</p>
            <div>
              <Button
                size="sm"
                variant="destructive"
                disabled={life.busy || Boolean(blocked)}
                onClick={() => setConfirm("delete")}
              >
                Request deletion
              </Button>
            </div>
          </div>
        </>
      )}
      {life.error && !confirm && (
        <p role="alert" className="text-xs text-destructive">
          {life.error}
        </p>
      )}

      <AlertDialog open={confirm === "deactivate"} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate your account?</AlertDialogTitle>
            <AlertDialogDescription>{DEACTIVATE_EXPLAINER}</AlertDialogDescription>
          </AlertDialogHeader>
          {life.error && (
            <p role="alert" className="text-xs text-destructive">
              {life.error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my account</AlertDialogCancel>
            <Button disabled={life.busy} onClick={() => void run("deactivate")}>
              Deactivate
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "delete"} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your account?</AlertDialogTitle>
            <AlertDialogDescription>{DELETE_EXPLAINER}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="confirm-delete">Type DELETE to confirm</Label>
            <Input
              id="confirm-delete"
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          {life.error && (
            <p role="alert" className="text-xs text-destructive">
              {life.error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my account</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={life.busy || typed.trim().toUpperCase() !== "DELETE"}
              onClick={() => void run("request_deletion")}
            >
              Request deletion
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
