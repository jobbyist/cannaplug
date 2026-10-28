import { useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Hide a cancelled or unpaid order from the lists (test orders, abandoned checkouts). Nothing is deleted: the
 * order stays in the records and can be restored. A paid order can't be archived (the database refuses it).
 */
export function ArchiveOrder({
  orderNumber,
  status,
  archivedAt,
  archiveReason,
  onArchive,
}: {
  orderNumber: string;
  status: string;
  archivedAt: string | null;
  archiveReason: string | null;
  onArchive: (archived: boolean, reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archived = !!archivedAt;
  if (!archived && status !== "awaiting_payment" && status !== "cancelled") return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onArchive(!archived, reason.trim());
      setOpen(false);
      setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-border pt-4">
      {archived && (
        <p className="mb-2 text-xs text-muted-foreground">
          Archived{archiveReason ? `: ${archiveReason}` : ""}. Hidden from the order list.
        </p>
      )}
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}{" "}
        {archived ? "Restore order" : "Archive order"}
      </Button>
      <AlertDialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {archived ? "Restore" : "Archive"} {orderNumber}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {archived
                ? "The order will show in the order list again."
                : status === "awaiting_payment"
                  ? "The order is cancelled first (its stock goes back on the shelf) and then hidden from the lists. The record is kept."
                  : "The order is hidden from the lists. The record is kept and it can be restored."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="grid gap-1 text-xs font-semibold">
            Reason (kept in the audit log)
            <Textarea
              rows={2}
              value={reason}
              maxLength={200}
              placeholder="e.g. test order"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || reason.trim().length < 3}
              onClick={(e) => {
                e.preventDefault(); // stay open until the server answers
                void submit();
              }}
            >
              {archived ? "Restore" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
