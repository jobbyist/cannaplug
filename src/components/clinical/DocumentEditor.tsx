import { useEffect, useMemo, useState } from "react";
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
import {
  createDocumentFn,
  getDoctorViewFn,
  submitForReviewFn,
  updateDraftFn,
} from "@/lib/clinical/clinical.functions";
import {
  PRESCRIPTION_FIELD_LABELS,
  documentTypeLabel,
  validatePrescription,
  type DocumentType,
  type PrescriptionInput,
} from "@/lib/clinical/logic";
import type { DoctorView, PatientRow, TemplateRow } from "@/lib/clinical/documents-data.server";
import {
  Notice,
  dateInputValue,
  endOfDaySast,
  errorText,
  selectClass,
} from "@/components/clinical/shared";

/**
 * Create or edit a draft. Every clinical value here is typed by the practitioner: there are no defaults,
 * no suggestions, no auto-fill and no pre-selected values anywhere in this form. The only help is
 * checking that required values are present and that the quantity in words agrees with the figures.
 */

export type EditorTarget =
  | { mode: "new"; type: DocumentType; memberId?: string; supersedes?: string }
  | { mode: "edit"; documentId: string };

type Props = {
  target: EditorTarget | null;
  patients: PatientRow[];
  templates: TemplateRow[];
  canPrescribe: boolean;
  onClose: () => void;
  /** Called after a draft is frozen for review. */
  onReadyForReview: (documentId: string) => void;
  onSaved: () => void;
};

const CLINICAL_FIELDS = [
  { key: "statement", label: "Practitioner statement", rows: 7 },
  { key: "indication_summary", label: "Indication summary (optional)", rows: 3 },
  { key: "treatment_summary", label: "Treatment summary (optional)", rows: 3 },
] as const;

const RX_TEXT_FIELDS = [
  "medicine_name",
  "generic_name",
  "dosage_form",
  "strength",
  "route",
  "frequency",
  "duration",
  "indication",
] as const;

export function DocumentEditor({
  target,
  patients,
  templates,
  canPrescribe,
  onClose,
  onReadyForReview,
  onSaved,
}: Props) {
  const key = useIdempotencyKey();
  const [type, setType] = useState<DocumentType>("MEDICAL_LETTER");
  const [memberId, setMemberId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [clinical, setClinical] = useState<Record<string, string>>({});
  const [rx, setRx] = useState<Record<string, string>>({});
  const [expiry, setExpiry] = useState("");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [supersedes, setSupersedes] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setClinical({});
    setRx({});
    setExpiry("");
    setDocumentId(null);
    setReviewNote(null);
    setSupersedes(null);
    key.reset();
    if (!target) return;
    if (target.mode === "new") {
      setType(target.type);
      setMemberId(target.memberId ?? "");
      setTemplateId("");
      setSupersedes(target.supersedes ?? null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const v: DoctorView = await getDoctorViewFn({ data: { documentId: target.documentId } });
        if (cancelled) return;
        setDocumentId(v.id);
        setType(v.document_type);
        setMemberId(v.member_id);
        setTemplateId(v.template_id ?? "");
        setReviewNote(v.review_note);
        setExpiry(dateInputValue(v.expires_at));
        const c = (v.snapshot.clinical ?? {}) as Record<string, string>;
        setClinical(c);
        const p = v.prescription ?? {};
        setRx(
          Object.fromEntries(
            Object.entries(p).map(([k, val]) => [
              k,
              val === null || val === undefined ? "" : String(val),
            ]),
          ),
        );
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const eligibleTemplates = useMemo(
    () => templates.filter((t) => t.document_type === type && t.status === "ACTIVE"),
    [templates, type],
  );
  const rxInput = useMemo<PrescriptionInput>(() => {
    const n = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : Number(v));
    const s = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
    return {
      medicine_name: s(rx["medicine_name"]),
      generic_name: s(rx["generic_name"]),
      dosage_form: s(rx["dosage_form"]),
      strength: s(rx["strength"]),
      quantity_numeric: n(rx["quantity_numeric"]),
      quantity_words: s(rx["quantity_words"]),
      directions: s(rx["directions"]),
      route: s(rx["route"]),
      frequency: s(rx["frequency"]),
      duration: s(rx["duration"]),
      repeats: n(rx["repeats"]),
      indication: s(rx["indication"]),
      special_instructions: s(rx["special_instructions"]),
    };
  }, [rx]);
  const problems = useMemo(
    () =>
      type === "PRESCRIPTION_ORDER"
        ? validatePrescription(rxInput, expiry ? endOfDaySast(expiry) : null)
        : [],
    [type, rxInput, expiry],
  );

  const save = async (): Promise<string | null> => {
    const clinicalPayload = Object.fromEntries(
      Object.entries(clinical).filter(([, v]) => v.trim() !== ""),
    );
    if (documentId) {
      await updateDraftFn({
        data: {
          documentId,
          clinical: type === "MEDICAL_LETTER" ? clinicalPayload : null,
          prescription: type === "PRESCRIPTION_ORDER" ? rxInput : null,
          setExpiry: true,
          expiresAt: expiry ? endOfDaySast(expiry) : null,
        },
      });
      return documentId;
    }
    const created = await createDocumentFn({
      data: {
        type,
        memberId,
        templateId,
        clinical: type === "MEDICAL_LETTER" ? clinicalPayload : null,
        prescription: type === "PRESCRIPTION_ORDER" ? rxInput : null,
        expiresAt: expiry ? endOfDaySast(expiry) : null,
        supersedes,
        key: key.get(),
      },
    });
    setDocumentId(created.id);
    return created.id;
  };

  const run = async (andReview: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const id = await save();
      if (andReview && id) {
        await submitForReviewFn({ data: { documentId: id } });
        onSaved();
        onReadyForReview(id);
        return;
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const canSave = Boolean(memberId && templateId) || Boolean(documentId);
  const ready =
    canSave &&
    (type === "MEDICAL_LETTER" ? Boolean(clinical["statement"]?.trim()) : problems.length === 0);

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {documentId ? "Edit draft" : `New ${documentTypeLabel(type).toLowerCase()}`}
          </DialogTitle>
          <DialogDescription>
            You write every clinical statement and value yourself. Nothing here is suggested or
            filled in for you.
          </DialogDescription>
        </DialogHeader>
        {error && <Notice tone="error">{error}</Notice>}
        {reviewNote && <Notice tone="warn">Changes requested: {reviewNote}</Notice>}

        {!documentId && (
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="doc-type">Document type</Label>
              <select
                id="doc-type"
                className={selectClass}
                value={type}
                disabled={target?.mode === "new" && Boolean(target.supersedes)}
                onChange={(e) => {
                  setType(e.target.value as DocumentType);
                  setTemplateId("");
                }}
              >
                <option value="MEDICAL_LETTER">Medical letter</option>
                <option value="PRESCRIPTION_ORDER" disabled={!canPrescribe}>
                  Prescription / order{canPrescribe ? "" : " (not authorised)"}
                </option>
              </select>
            </div>
            <div>
              <Label htmlFor="doc-patient">Patient</Label>
              <select
                id="doc-patient"
                className={selectClass}
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
              >
                <option value="">Select…</option>
                {patients
                  .filter((p) => p.identity_verified)
                  .map((p) => (
                    <option key={p.member_id} value={p.member_id}>
                      {p.full_name} ({p.member_ref})
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <Label htmlFor="doc-template">Template</Label>
              <select
                id="doc-template"
                className={selectClass}
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
              >
                <option value="">Select…</option>
                {eligibleTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} v{t.version}
                  </option>
                ))}
              </select>
              {eligibleTemplates.length === 0 && (
                <p className="mt-1 text-[0.7rem] text-muted-foreground">
                  No approved template is active for this type yet.
                </p>
              )}
            </div>
          </div>
        )}

        {type === "MEDICAL_LETTER" ? (
          <div className="grid gap-3">
            {CLINICAL_FIELDS.map((f) => (
              <div key={f.key}>
                <Label htmlFor={`c-${f.key}`}>{f.label}</Label>
                <Textarea
                  id={`c-${f.key}`}
                  rows={f.rows}
                  maxLength={4000}
                  value={clinical[f.key] ?? ""}
                  onChange={(e) => setClinical({ ...clinical, [f.key]: e.target.value })}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {RX_TEXT_FIELDS.map((f) => (
              <div key={f}>
                <Label htmlFor={`rx-${f}`}>{PRESCRIPTION_FIELD_LABELS[f]}</Label>
                <Input
                  id={`rx-${f}`}
                  value={rx[f] ?? ""}
                  maxLength={f === "indication" ? 500 : 200}
                  onChange={(e) => setRx({ ...rx, [f]: e.target.value })}
                />
              </div>
            ))}
            <div>
              <Label htmlFor="rx-qn">{PRESCRIPTION_FIELD_LABELS.quantity_numeric}</Label>
              <Input
                id="rx-qn"
                inputMode="decimal"
                value={rx["quantity_numeric"] ?? ""}
                onChange={(e) => setRx({ ...rx, quantity_numeric: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="rx-qw">{PRESCRIPTION_FIELD_LABELS.quantity_words}</Label>
              <Input
                id="rx-qw"
                value={rx["quantity_words"] ?? ""}
                maxLength={200}
                onChange={(e) => setRx({ ...rx, quantity_words: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="rx-rep">{PRESCRIPTION_FIELD_LABELS.repeats}</Label>
              <Input
                id="rx-rep"
                inputMode="numeric"
                value={rx["repeats"] ?? ""}
                onChange={(e) => setRx({ ...rx, repeats: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="rx-dir">{PRESCRIPTION_FIELD_LABELS.directions}</Label>
              <Textarea
                id="rx-dir"
                rows={3}
                maxLength={1000}
                value={rx["directions"] ?? ""}
                onChange={(e) => setRx({ ...rx, directions: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="rx-si">
                {PRESCRIPTION_FIELD_LABELS.special_instructions} (optional)
              </Label>
              <Textarea
                id="rx-si"
                rows={2}
                maxLength={1000}
                value={rx["special_instructions"] ?? ""}
                onChange={(e) => setRx({ ...rx, special_instructions: e.target.value })}
              />
            </div>
          </div>
        )}

        <div className="max-w-xs">
          <Label htmlFor="doc-expiry">
            {type === "PRESCRIPTION_ORDER" ? "Valid until (required)" : "Valid until (optional)"}
          </Label>
          <Input
            id="doc-expiry"
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </div>

        {type === "PRESCRIPTION_ORDER" && problems.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {problems.map((p) => (
              <li key={p.field + p.message}>{p.message}</li>
            ))}
          </ul>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => void run(false)} disabled={busy || !canSave}>
            Save draft
          </Button>
          <Button onClick={() => void run(true)} disabled={busy || !ready}>
            Prepare for review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
