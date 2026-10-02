import { useCallback, useEffect, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  decideDocumentFn,
  getDoctorViewFn,
  openDocumentFn,
  retryIssueFn,
  revokeDocumentFn,
  signDocumentFn,
  signingOptionsFn,
  voidDocumentFn,
} from "@/lib/clinical/clinical.functions";
import {
  ASSURANCE_LABELS,
  documentTypeLabel,
  signaturePlaceholderValues,
} from "@/lib/clinical/logic";
import { resolveLateBound } from "@/lib/clinical/template-engine";
import type { DoctorView, SigningOption } from "@/lib/clinical/documents-data.server";
import {
  Notice,
  StatusBadge,
  errorText,
  selectClass,
  when,
  whenTime,
} from "@/components/clinical/shared";

/**
 * The practitioner's review screen. It shows the EXACT frozen text that will be signed and the hash it
 * was frozen under. Approving sends that hash back; if the document on file is not the document that was
 * shown, the database refuses. The practitioner confirms explicitly; nothing is pre-ticked.
 */

type Props = {
  documentId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onEditDraft: (documentId: string) => void;
  onNewVersion: (view: DoctorView) => void;
};

type Mode = null | "reject" | "changes" | "void" | "revoke";

export function ReviewDialog({ documentId, onClose, onChanged, onEditDraft, onNewVersion }: Props) {
  const [view, setView] = useState<DoctorView | null>(null);
  const [options, setOptions] = useState<{
    required: string;
    policyConfirmed: boolean;
    options: SigningOption[];
  } | null>(null);
  const [provider, setProvider] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [mode, setMode] = useState<Mode>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (id: string, keepError = false) => {
    if (!keepError) setError(null);
    try {
      const v = await getDoctorViewFn({ data: { documentId: id } });
      setView(v);
      if (v.status === "PENDING_DOCTOR_REVIEW" || v.status === "APPROVED") {
        const o = await signingOptionsFn({ data: { type: v.document_type } });
        setOptions(o);
        setProvider(o.options.find((x) => x.usable)?.provider ?? "");
      }
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    setView(null);
    setOptions(null);
    setConfirmed(false);
    setMode(null);
    setNote("");
    setNotice(null);
    if (documentId) void load(documentId);
  }, [documentId, load]);

  const act = async (fn: () => Promise<unknown>, done: string, close = false) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setNotice(done);
      onChanged();
      if (close) onClose();
      else if (documentId) await load(documentId);
    } catch (err) {
      setError(errorText(err));
      if (documentId) await load(documentId, true);
    } finally {
      setBusy(false);
      setMode(null);
      setNote("");
    }
  };

  const sign = async () => {
    if (!view?.document_hash) return;
    const hash = view.document_hash;
    setBusy(true);
    setError(null);
    try {
      if (view.status === "PENDING_DOCTOR_REVIEW")
        await decideDocumentFn({
          data: { documentId: view.id, decision: "approve", expectedHash: hash },
        });
      const r = await signDocumentFn({
        data: { documentId: view.id, expectedHash: hash, provider },
      });
      setNotice(
        r.status === "SIGNING"
          ? "Sent to the signature provider. The document is issued automatically once signing completes."
          : "Signed and issued. The member has been notified.",
      );
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      if (documentId) await load(documentId, true);
      setBusy(false);
    }
  };

  const openPdf = async () => {
    if (!view) return;
    const tab = window.open("about:blank", "_blank");
    try {
      const { url } = await openDocumentFn({ data: { documentId: view.id, kind: "VIEWED" } });
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else window.location.assign(url);
    } catch (err) {
      tab?.close();
      setError(errorText(err));
    }
  };

  const d = (view?.snapshot.doctor ?? {}) as Record<string, string | undefined>;
  const m = (view?.snapshot.member ?? {}) as Record<string, string | undefined>;
  const usable = options?.options.filter((o) => o.usable) ?? [];
  const canDecide = view?.status === "PENDING_DOCTOR_REVIEW";
  const canSign = canDecide || view?.status === "APPROVED";

  return (
    <Dialog open={documentId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {view ? documentTypeLabel(view.document_type) : "Document"}{" "}
            {view && <StatusBadge status={view.status} />}
          </DialogTitle>
          <DialogDescription>
            {canSign
              ? "This is the exact document that will be signed. Read it in full before approving."
              : "Practitioner view of this document."}
          </DialogDescription>
        </DialogHeader>
        {error && <Notice tone="error">{error}</Notice>}
        {notice && <Notice tone="ok">{notice}</Notice>}
        {!view && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

        {view && (
          <div className="grid gap-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
              <Fact label="Document ID" value={view.document_id} />
              <Fact label="Patient" value={`${m["full_name"] ?? "—"} (${m["member_id"] ?? "—"})`} />
              <Fact label="Date of birth" value={m["date_of_birth"] ?? "—"} />
              <Fact
                label="Practitioner"
                value={`${d["title"] ?? ""} ${d["full_name"] ?? ""}`.trim()}
              />
              <Fact label="HPCSA number" value={d["hpcsa_number"] ?? "—"} />
              <Fact
                label="Template version"
                value={`v${view.template_version} · document v${view.document_version}`}
              />
              <Fact label="Created" value={whenTime(view.created_at)} />
              <Fact
                label="Valid until"
                value={view.expires_at ? when(view.expires_at) : "No expiry"}
              />
              <Fact
                label="Content hash (SHA-256)"
                value={
                  view.document_hash ? `${view.document_hash.slice(0, 16)}…` : "Not frozen yet"
                }
                title={view.document_hash ?? undefined}
              />
            </dl>

            {view.rendered_content ? (
              <div>
                <p className="mb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  Document text{canSign ? " — exactly as it will be signed" : ""}
                </p>
                <pre
                  aria-label="Exact document text"
                  className="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-4 font-sans text-sm leading-relaxed"
                >
                  {resolveLateBound(
                    view.rendered_content,
                    ["DRAFT", "PENDING_DOCTOR_REVIEW", "APPROVED", "SIGNING"].includes(view.status)
                      ? signaturePlaceholderValues(null)
                      : {
                          "signature.status": "See the signed PDF",
                          "signature.signed_at": "See the signed PDF",
                        },
                  )}
                </pre>
              </div>
            ) : (
              <Notice tone="warn">
                This draft has not been prepared yet.{" "}
                {view.review_note ? `Changes requested: ${view.review_note}` : ""}
              </Notice>
            )}
            {view.revocation_reason && (
              <Notice tone="warn">Reason recorded: {view.revocation_reason}</Notice>
            )}

            {canSign && (
              <div className="grid gap-3 rounded-lg border border-border p-4">
                {options && !options.policyConfirmed && (
                  <Notice tone="warn">
                    The signature level for this document type has not been confirmed by compliance
                    yet, so it cannot be signed.
                  </Notice>
                )}
                {options && options.policyConfirmed && usable.length === 0 && (
                  <Notice tone="warn">
                    No signature method is available to you for this document (required:{" "}
                    {ASSURANCE_LABELS[options.required as keyof typeof ASSURANCE_LABELS]}).
                    {options.options
                      .map((o) => ` ${o.displayName}: ${o.reason ?? "available"}.`)
                      .join("")}
                  </Notice>
                )}
                {usable.length > 0 && (
                  <div className="max-w-sm">
                    <Label htmlFor="sig-provider">Signature method</Label>
                    <select
                      id="sig-provider"
                      className={selectClass}
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                    >
                      {usable.map((o) => (
                        <option key={o.provider} value={o.provider}>
                          {o.displayName} — {ASSURANCE_LABELS[o.assurance]}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <label className="flex items-start gap-3 text-sm">
                  <Checkbox
                    checked={confirmed}
                    onCheckedChange={(v) => setConfirmed(v === true)}
                    aria-label="I have reviewed this exact document"
                  />
                  <span>
                    I have read this document in full. I confirm it is accurate and that I am
                    approving and signing <strong>this exact document</strong> ({view.document_id})
                    as {d["title"]} {d["full_name"]}.
                  </span>
                </label>
              </div>
            )}

            {mode && (
              <div className="grid gap-2">
                <Label htmlFor="review-note">
                  {mode === "changes" ? "What needs to change?" : "Reason"}
                </Label>
                <Textarea
                  id="review-note"
                  rows={3}
                  maxLength={mode === "revoke" ? 500 : 1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    disabled={busy || note.trim().length < 3}
                    onClick={() =>
                      void act(
                        () =>
                          mode === "revoke"
                            ? revokeDocumentFn({ data: { documentId: view.id, reason: note } })
                            : mode === "void"
                              ? voidDocumentFn({ data: { documentId: view.id, reason: note } })
                              : decideDocumentFn({
                                  data: {
                                    documentId: view.id,
                                    decision: mode === "reject" ? "reject" : "request_changes",
                                    note,
                                  },
                                }),
                        mode === "revoke"
                          ? "Document revoked."
                          : mode === "void"
                            ? "Document voided."
                            : mode === "reject"
                              ? "Document rejected."
                              : "Returned to draft for changes.",
                        mode !== "changes",
                      )
                    }
                  >
                    Confirm
                  </Button>
                  <Button variant="outline" onClick={() => setMode(null)}>
                    Back
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {view && !mode && (
          <DialogFooter className="flex-wrap gap-2">
            {canDecide && (
              <>
                <Button variant="outline" disabled={busy} onClick={() => setMode("changes")}>
                  Request changes
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setMode("reject")}>
                  Reject
                </Button>
              </>
            )}
            {canSign && (
              <Button
                disabled={busy || !confirmed || !provider || !view.document_hash}
                onClick={() => void sign()}
              >
                {view.status === "APPROVED" ? "Sign" : "Approve & Sign"}
              </Button>
            )}
            {view.status === "DRAFT" && (
              <>
                <Button variant="outline" disabled={busy} onClick={() => setMode("void")}>
                  Void draft
                </Button>
                <Button disabled={busy} onClick={() => onEditDraft(view.id)}>
                  Edit draft
                </Button>
              </>
            )}
            {view.status === "APPROVED" && (
              <Button variant="outline" disabled={busy} onClick={() => setMode("void")}>
                Withdraw
              </Button>
            )}
            {view.status === "SIGNED" && (
              <Button
                disabled={busy}
                onClick={() =>
                  void act(
                    () => retryIssueFn({ data: { documentId: view.id } }),
                    "Document issued.",
                  )
                }
              >
                Finish issuing
              </Button>
            )}
            {(view.status === "ISSUED" || view.status === "EXPIRED") && (
              <>
                <Button variant="outline" disabled={busy} onClick={() => void openPdf()}>
                  View PDF
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setMode("revoke")}>
                  Revoke
                </Button>
              </>
            )}
            {(view.status === "REVOKED" || view.status === "EXPIRED") && (
              <Button disabled={busy} onClick={() => onNewVersion(view)}>
                Create new version
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Fact({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string | undefined;
}) {
  return (
    <div>
      <dt className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="break-words font-medium" title={title}>
        {value}
      </dd>
    </div>
  );
}
