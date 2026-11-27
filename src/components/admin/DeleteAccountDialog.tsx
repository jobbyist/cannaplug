import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import { deleteMemberAccountFn } from "@/lib/account-lifecycle.functions";
import { reasonProblem } from "@/lib/account-lifecycle";

export type DeleteTarget = { id: string; name: string; requested: boolean };

/**
 * Admin: complete a member's deletion. The member is anonymised, not erased: orders, receipts and any medical
 * documents are kept without their name. The reason goes in the audit log (no personal data in it).
 */
export function DeleteAccountDialog({
  member,
  onClose,
  onDeleted,
}: {
  member: DeleteTarget | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  return (
    <Dialog open={!!member} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {member && <Form key={member.id} member={member} onClose={onClose} onDeleted={onDeleted} />}
      </DialogContent>
    </Dialog>
  );
}

function Form({
  member,
  onClose,
  onDeleted,
}: {
  member: DeleteTarget;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [reason, setReason] = useState(
    member.requested ? "Requested by the member in the app" : "",
  );
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const key = useIdempotencyKey();
  const ok = !reasonProblem(reason) && typed.trim().toUpperCase() === "DELETE";

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await deleteMemberAccountFn({
        data: { memberId: member.id, reason: reason.trim(), key: key.get() },
      });
      key.reset();
      onDeleted();
      if (r.warnings.length > 0) setWarnings(r.warnings);
      else onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the account. Please retry.");
    } finally {
      setBusy(false);
    }
  };

  if (warnings) {
    return (
      <div className="grid gap-4">
        <DialogHeader>
          <DialogTitle>Account deleted, with follow-ups</DialogTitle>
          <DialogDescription>
            {member.name} was anonymised. Two things need a hand:
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc pl-5 text-sm">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) void run();
      }}
    >
      <DialogHeader>
        <DialogTitle>Delete {member.name}&apos;s account</DialogTitle>
        <DialogDescription>
          This cannot be undone. Their name, phone, address, date of birth, ID details and saved
          items are removed and they can no longer sign in. Orders, receipts and any medical
          documents are kept without their name. Refused if they have an order in progress.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="delete-reason">Reason</Label>
        <Textarea
          id="delete-reason"
          rows={2}
          maxLength={200}
          placeholder="For example: asked by WhatsApp on 27 Nov"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="delete-confirm">Type DELETE to confirm</Label>
        <Input
          id="delete-confirm"
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={busy || !ok}>
          {busy ? "Deleting…" : "Delete account"}
        </Button>
      </DialogFooter>
    </form>
  );
}
