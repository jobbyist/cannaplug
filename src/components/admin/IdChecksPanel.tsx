import { useCallback, useEffect, useState } from "react";
import { Eye, ShieldCheck } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import {
  listVerificationsFn,
  reviewVerificationFn,
  viewVerificationDocumentFn,
} from "@/lib/verification.functions";
import type { VerificationQueueItem } from "@/lib/verification-data.server";
import { REJECTION_REASONS, documentTypeLabel, type RejectionCode } from "@/lib/verification-logic";

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : "Something went wrong. Please try again.";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" }) : "—";

const ageOf = (dob: string | null) => {
  if (!dob) return null;
  const born = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  if (
    now.getMonth() < born.getMonth() ||
    (now.getMonth() === born.getMonth() && now.getDate() < born.getDate())
  )
    age -= 1;
  return age;
};

type Scope = "pending" | "decided";

export function IdChecksPanel() {
  const [scope, setScope] = useState<Scope>("pending");
  const [items, setItems] = useState<VerificationQueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<VerificationQueueItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (which: Scope) => {
    try {
      setError(null);
      setItems(await listVerificationsFn({ data: { scope: which } }));
    } catch (err) {
      setItems([]);
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    setItems(null);
    void load(scope);
  }, [scope, load]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-xl font-extrabold uppercase">ID checks</h1>
        <div className="flex gap-2" role="tablist" aria-label="ID check list">
          {(["pending", "decided"] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              role="tab"
              aria-selected={scope === s}
              variant={scope === s ? "default" : "outline"}
              onClick={() => setScope(s)}
            >
              {s === "pending" ? "Waiting for review" : "Recently decided"}
            </Button>
          ))}
        </div>
      </div>
      {notice && (
        <p role="status" className="mb-3 rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      {items === null && <p className="text-sm text-muted-foreground">Loading…</p>}
      {items && items.length === 0 && !error && (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {scope === "pending" ? "No IDs are waiting for review." : "Nothing decided yet."}
        </p>
      )}
      {items && items.length > 0 && (
        <Table data-testid="id-checks-table">
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Document</TableHead>
              <TableHead>Declared DOB</TableHead>
              <TableHead>{scope === "pending" ? "Submitted" : "Decided"}</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.user_id}>
                <TableCell>
                  <p className="font-medium">{item.full_name ?? "Unnamed"}</p>
                  <p className="text-xs text-muted-foreground">{item.email ?? "—"}</p>
                </TableCell>
                <TableCell>{documentTypeLabel(item.document_type)}</TableCell>
                <TableCell>
                  {item.declared_dob ?? "—"}
                  {ageOf(item.declared_dob) !== null && (
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      ({ageOf(item.declared_dob)})
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {when(scope === "pending" ? item.submitted_at : item.reviewed_at)}
                </TableCell>
                <TableCell>
                  <Badge>{item.status}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" onClick={() => setSelected(item)}>
                    {item.status === "pending" ? "Review" : "Details"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {selected && (
        <ReviewDialog
          item={selected}
          onClose={() => setSelected(null)}
          onDecided={async (message) => {
            setSelected(null);
            setNotice(message);
            await load(scope);
          }}
        />
      )}
    </div>
  );
}

function ReviewDialog({
  item,
  onClose,
  onDecided,
}: {
  item: VerificationQueueItem;
  onClose: () => void;
  onDecided: (message: string) => Promise<void>;
}) {
  const pending = item.status === "pending";
  const [doc, setDoc] = useState<{ url: string; isPdf: boolean } | null>(null);
  const [opening, setOpening] = useState(false);
  const [checked, setChecked] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [code, setCode] = useState<RejectionCode | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useIdempotencyKey();

  const open = async () => {
    setOpening(true);
    setError(null);
    try {
      const result = await viewVerificationDocumentFn({ data: { userId: item.user_id } });
      setDoc({ url: result.url, isPdf: result.isPdf });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setOpening(false);
    }
  };

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      await reviewVerificationFn({
        data: {
          userId: item.user_id,
          decision,
          rejectionCode: decision === "reject" && code ? code : null,
          note: note.trim() === "" ? null : note.trim(),
          key: key.get(),
        },
      });
      key.reset();
      await onDecided(
        decision === "approve"
          ? `${item.full_name ?? "Member"} is verified and can now order.`
          : `${item.full_name ?? "Member"}'s ID was rejected; they've been told why.`,
      );
    } catch (err) {
      setError(errorText(err));
      key.reset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{item.full_name ?? "Member"} — ID review</DialogTitle>
          <DialogDescription>
            {documentTypeLabel(item.document_type)} · declared date of birth{" "}
            {item.declared_dob ?? "—"}
            {ageOf(item.declared_dob) !== null && ` (age ${ageOf(item.declared_dob)})`} · submission{" "}
            {item.attempt_count}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border p-3">
          {doc ? (
            doc.isPdf ? (
              <a
                href={doc.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sm font-semibold text-primary underline"
              >
                Open the PDF in a new tab
              </a>
            ) : (
              <img
                src={doc.url}
                alt={`ID document for ${item.full_name ?? "member"}`}
                className="max-h-80 w-full rounded object-contain"
              />
            )
          ) : (
            <Button size="sm" variant="outline" disabled={opening} onClick={() => void open()}>
              <Eye size={14} className="mr-1.5" />
              {opening ? "Opening…" : "View ID document"}
            </Button>
          )}
          <p className="mt-2 text-[0.7rem] text-muted-foreground">
            Opening an ID is logged against your name. The link expires after 60 seconds.
          </p>
        </div>

        {!pending && (
          <p className="text-xs text-muted-foreground">
            Decided {when(item.reviewed_at)}
            {item.rejection_code &&
              ` — rejected: ${REJECTION_REASONS.find((r) => r.code === item.rejection_code)?.label ?? item.rejection_code}`}
            {item.rejection_note && ` (${item.rejection_note})`}
          </p>
        )}

        {pending && !rejecting && (
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <span>
              I have checked that the photo is the member, the name matches their account, the
              document is current, and the date of birth matches and is 18+.
            </span>
          </label>
        )}

        {pending && rejecting && (
          <div className="grid gap-2">
            <Label htmlFor="reject-reason">Reason (shown to the member)</Label>
            <select
              id="reject-reason"
              value={code}
              onChange={(e) => setCode(e.target.value as RejectionCode | "")}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Choose a reason…</option>
              {REJECTION_REASONS.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
            <Label htmlFor="reject-note">
              Note {code === "other" ? "(required)" : "(optional)"}
            </Label>
            <Textarea
              id="reject-note"
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Visible to the member — don't include anything private."
            />
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {pending && !rejecting && (
            <>
              <Button variant="outline" onClick={() => setRejecting(true)}>
                Reject…
              </Button>
              <Button disabled={!checked || busy} onClick={() => void decide("approve")}>
                <ShieldCheck size={14} className="mr-1.5" />
                {busy ? "Approving…" : "Approve"}
              </Button>
            </>
          )}
          {pending && rejecting && (
            <>
              <Button variant="outline" onClick={() => setRejecting(false)}>
                Back
              </Button>
              <Button
                variant="destructive"
                disabled={!code || (code === "other" && note.trim() === "") || busy}
                onClick={() => void decide("reject")}
              >
                {busy ? "Rejecting…" : "Confirm rejection"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
