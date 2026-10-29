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
import { useUsernameCheck } from "@/components/account/use-username-check";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import { setCustomerUsernameFn } from "@/lib/admin.functions";
import { normaliseUsername } from "@/lib/rewards-logic";

export type UsernameTarget = { id: string; name: string; username: string | null };

/**
 * Managers and admins change a member's username (it is also their referral code, so any link using the old name
 * stops working). A reason is required and is kept in the audit log with the old and the new name.
 */
export function UsernameEditDialog({
  member,
  onClose,
  onSaved,
}: {
  member: UsernameTarget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={!!member} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {member && <Form key={member.id} member={member} onClose={onClose} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}

function Form({
  member,
  onClose,
  onSaved,
}: {
  member: UsernameTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(member.username ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useIdempotencyKey();
  const unchanged = normaliseUsername(value) === (member.username ?? "");
  const check = useUsernameCheck(unchanged ? "" : value);
  const ok = !unchanged && check.state === "ok" && reason.trim().length >= 3;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await setCustomerUsernameFn({
        data: {
          memberId: member.id,
          username: normaliseUsername(value),
          reason: reason.trim(),
          key: key.get(),
        },
      });
      key.reset();
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the username. Please retry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>Change username</DialogTitle>
        <DialogDescription>
          {member.name}. The username is also their referral code, so any link that used the old
          name stops working. The change is recorded in the audit log.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="admin-username">New username</Label>
        <Input
          id="admin-username"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={20}
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/\s/g, ""))}
        />
        <p
          aria-live="polite"
          data-testid="admin-username-status"
          className={
            "text-xs " +
            (check.state === "ok"
              ? "text-primary"
              : check.state === "idle" || check.state === "checking"
                ? "text-muted-foreground"
                : "text-destructive")
          }
        >
          {unchanged
            ? member.username
              ? `Current username: ${member.username}`
              : "This member has no username yet."
            : check.state === "checking"
              ? "Checking…"
              : check.state === "idle"
                ? "3 to 20 letters, numbers or underscores."
                : check.message}
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="admin-username-reason">Reason</Label>
        <Textarea
          id="admin-username-reason"
          rows={2}
          maxLength={200}
          placeholder="For example: the member asked for a new name"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
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
        <Button type="submit" disabled={busy || !ok}>
          {busy ? "Saving…" : "Change username"}
        </Button>
      </DialogFooter>
    </form>
  );
}
