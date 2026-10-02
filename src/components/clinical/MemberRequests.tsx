import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import {
  cancelMyRequestFn,
  createMyRequestFn,
  listMyRequestsFn,
} from "@/lib/clinical/clinical.functions";
import type { MemberRequestRow, RequestStatus } from "@/lib/clinical/documents-data.server";
import { documentTypeLabel, type DocumentType } from "@/lib/clinical/logic";
import { Notice, errorText, selectClass, when } from "@/components/clinical/shared";

/**
 * A member asks for a medical letter or a prescription/order. A request is only a request: it is triaged by
 * CannaPlug and then assessed by a practitioner, who decides whether anything is issued and what it says.
 * The optional note is seen by the member and the assigned practitioner only, never by administrators.
 */

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  REQUESTED: "Waiting to be assigned",
  ASSIGNED: "With your practitioner",
  IN_PROGRESS: "Being prepared",
  FULFILLED: "Completed",
  DECLINED: "Not going ahead",
  CANCELLED: "Cancelled",
};

const VARIANT: Record<RequestStatus, "default" | "secondary" | "outline" | "destructive"> = {
  REQUESTED: "secondary",
  ASSIGNED: "secondary",
  IN_PROGRESS: "secondary",
  FULFILLED: "default",
  DECLINED: "destructive",
  CANCELLED: "outline",
};

export function MemberRequests({ onFulfilled }: { onFulfilled?: () => void }) {
  const key = useIdempotencyKey();
  const [rows, setRows] = useState<MemberRequestRow[] | null>(null);
  const [type, setType] = useState<DocumentType>("MEDICAL_LETTER");
  const [note, setNote] = useState("");
  const fulfilledSeen = useRef(0);
  const onFulfilledRef = useRef(onFulfilled);
  onFulfilledRef.current = onFulfilled;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await listMyRequestsFn();
      setRows(r);
      // Refresh the documents list once when a request newly completes (its document has just been issued).
      const fulfilled = r.filter((x) => x.status === "FULFILLED").length;
      if (fulfilled > fulfilledSeen.current && fulfilledSeen.current !== 0)
        onFulfilledRef.current?.();
      fulfilledSeen.current = fulfilled;
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await createMyRequestFn({ data: { type, note: note.trim() || null, key: key.get() } });
      key.reset();
      setNote("");
      setNotice(
        "Request sent. CannaPlug will assign it to a practitioner and you'll see its progress here.",
      );
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    setError(null);
    try {
      await cancelMyRequestFn({ data: { requestId: id } });
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="grid gap-6">
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="ok">{notice}</Notice>}
      <div className="grid gap-3 rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide">Request a document</h2>
        <p className="text-xs text-muted-foreground">
          A request asks your practitioner to assess you. It is not a prescription and does not
          guarantee that a document will be issued — that is the practitioner&apos;s decision. You
          can have up to three open requests.
        </p>
        <div className="max-w-xs">
          <Label htmlFor="req-type">What do you need?</Label>
          <select
            id="req-type"
            className={selectClass}
            value={type}
            onChange={(e) => setType(e.target.value as DocumentType)}
          >
            <option value="MEDICAL_LETTER">A medical letter</option>
            <option value="PRESCRIPTION_ORDER">A prescription / medicine order</option>
          </select>
        </div>
        <div>
          <Label htmlFor="req-note">Note for your practitioner (optional)</Label>
          <Textarea
            id="req-note"
            rows={3}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="mt-1 text-[0.7rem] text-muted-foreground">
            Only you and your practitioner can read this note. CannaPlug administrators cannot.
          </p>
        </div>
        <div>
          <Button disabled={busy} onClick={() => void submit()}>
            Send request
          </Button>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">Your requests</h2>
        {rows === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {rows?.length === 0 && (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            You haven&apos;t made any requests yet.
          </p>
        )}
        <ul className="grid gap-3">
          {(rows ?? []).map((r) => (
            <li key={r.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">{documentTypeLabel(r.document_type)}</p>
                <Badge variant={VARIANT[r.status]}>{REQUEST_STATUS_LABELS[r.status]}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Requested {when(r.created_at)}
                {r.source === "admin" ? " (opened for you by CannaPlug)" : ""}
                {r.practitioner ? ` · ${r.practitioner}` : ""}
              </p>
              {r.status === "DECLINED" && r.decision_reason && (
                <p className="mt-2 text-xs">Reason given: {r.decision_reason}</p>
              )}
              {r.status === "FULFILLED" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Your document is under &ldquo;My documents&rdquo;.
                </p>
              )}
              {(r.status === "REQUESTED" || r.status === "ASSIGNED") && (
                <div className="mt-3">
                  <Button size="sm" variant="outline" onClick={() => void cancel(r.id)}>
                    Cancel request
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
