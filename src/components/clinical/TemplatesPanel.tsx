import { useCallback, useEffect, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createTemplateFn,
  decideTemplateFn,
  listTemplatesFn,
  newTemplateVersionFn,
  retireTemplateFn,
  submitTemplateFn,
  updateTemplateDraftFn,
} from "@/lib/clinical/clinical.functions";
import type { TemplateRow } from "@/lib/clinical/documents-data.server";
import { documentTypeLabel, type DocumentType } from "@/lib/clinical/logic";
import {
  ALLOWED_PLACEHOLDERS,
  defaultSchemaFor,
  validateTemplate,
} from "@/lib/clinical/template-engine";
import { Notice, errorText, selectClass, whenTime } from "@/components/clinical/shared";

/**
 * Template management for both the practitioner and the administrator. Templates are versioned: an active
 * version is never edited — a change creates a new draft version. Only a verified practitioner (for
 * prescriptions, one authorised to prescribe) can approve wording; the database enforces that, the buttons
 * here only reflect it.
 */

type Props = { role: "admin" | "doctor" };

const STATUS_VARIANT: Record<
  TemplateRow["status"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  ACTIVE: "default",
  PENDING_APPROVAL: "secondary",
  DRAFT: "outline",
  ARCHIVED: "outline",
  REVOKED: "destructive",
};

type Editing =
  | { mode: "new" }
  | { mode: "edit"; template: TemplateRow }
  | { mode: "version"; template: TemplateRow }
  | null;

export function TemplatesPanel({ role }: Props) {
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [viewing, setViewing] = useState<TemplateRow | null>(null);
  const [deciding, setDeciding] = useState<{ template: TemplateRow; approve: boolean } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      setRows(await listTemplatesFn());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="grid gap-4">
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="ok">{notice}</Notice>}
      <p className="text-xs text-muted-foreground">
        Templates hold wording and layout only — never a signature and never clinical values. The
        wording must be approved by a verified practitioner before it can be used.
      </p>
      <div>
        <Button onClick={() => setEditing({ mode: "new" })}>New template</Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Template</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Approved</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {(rows ?? []).map((t) => (
            <TableRow key={t.id}>
              <TableCell className="font-medium">
                {t.name}
                {t.review_note && (
                  <span className="block text-[0.7rem] font-normal text-muted-foreground">
                    Note: {t.review_note}
                  </span>
                )}
              </TableCell>
              <TableCell>{documentTypeLabel(t.document_type)}</TableCell>
              <TableCell>v{t.version}</TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANT[t.status]}>
                  {t.status.replace("_", " ").toLowerCase()}
                </Badge>
              </TableCell>
              <TableCell>{t.approved_at ? whenTime(t.approved_at) : "—"}</TableCell>
              <TableCell className="flex flex-wrap justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => setViewing(t)}>
                  View
                </Button>
                {t.status === "DRAFT" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing({ mode: "edit", template: t })}
                  >
                    Edit
                  </Button>
                )}
                {t.status === "DRAFT" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void act(
                        () => submitTemplateFn({ data: { templateId: t.id } }),
                        "Submitted for practitioner approval.",
                      )
                    }
                  >
                    Submit
                  </Button>
                )}
                {t.status === "PENDING_APPROVAL" && role === "doctor" && (
                  <>
                    <Button size="sm" onClick={() => setDeciding({ template: t, approve: true })}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDeciding({ template: t, approve: false })}
                    >
                      Send back
                    </Button>
                  </>
                )}
                {(t.status === "ACTIVE" || t.status === "ARCHIVED" || t.status === "REVOKED") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing({ mode: "version", template: t })}
                  >
                    New version
                  </Button>
                )}
                {t.status === "ACTIVE" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void act(
                        () =>
                          retireTemplateFn({
                            data: { templateId: t.id, revoke: false, note: "Archived" },
                          }),
                        "Template archived.",
                      )
                    }
                  >
                    Archive
                  </Button>
                )}
                {(t.status === "ACTIVE" || t.status === "PENDING_APPROVAL") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act(
                        () =>
                          retireTemplateFn({
                            data: { templateId: t.id, revoke: true, note: "Revoked" },
                          }),
                        "Template revoked.",
                      )
                    }
                  >
                    Revoke
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
          {rows?.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                No templates yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <TemplateEditor
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={async (fn, done) => {
          await act(fn, done);
          setEditing(null);
        }}
      />

      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {viewing?.name} v{viewing?.version}
            </DialogTitle>
            <DialogDescription>
              {viewing && documentTypeLabel(viewing.document_type)}
            </DialogDescription>
          </DialogHeader>
          <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-4 font-sans text-sm">
            {viewing?.template_content}
          </pre>
        </DialogContent>
      </Dialog>

      <DecisionDialog
        state={deciding}
        onClose={() => setDeciding(null)}
        onConfirm={(note, until) =>
          deciding &&
          act(
            () =>
              decideTemplateFn({
                data: {
                  templateId: deciding.template.id,
                  approve: deciding.approve,
                  note,
                  effectiveUntil: until ? `${until}T23:59:59+02:00` : null,
                },
              }),
            deciding.approve
              ? "Template approved and active."
              : "Template sent back with your note.",
          ).then(() => setDeciding(null))
        }
      />
    </section>
  );
}

function TemplateEditor({
  editing,
  onClose,
  onSave,
}: {
  editing: Editing;
  onClose: () => void;
  onSave: (fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const [type, setType] = useState<DocumentType>("MEDICAL_LETTER");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!editing) return;
    if (editing.mode === "new") {
      setType("MEDICAL_LETTER");
      setName("");
      setContent("");
      setNote("");
    } else {
      setType(editing.template.document_type);
      setName(editing.template.name);
      setContent(editing.template.template_content);
      setNote("");
    }
  }, [editing]);

  const schema = defaultSchemaFor(type, content);
  const problems = content.trim() ? validateTemplate(type, content, schema) : [];

  const save = () => {
    if (!editing) return Promise.resolve();
    if (editing.mode === "new")
      return onSave(
        () => createTemplateFn({ data: { type, name, content, schema, note: note || null } }),
        "Draft template created.",
      );
    if (editing.mode === "edit")
      return onSave(
        () =>
          updateTemplateDraftFn({
            data: { templateId: editing.template.id, content, schema, note: note || null },
          }),
        "Draft saved.",
      );
    return onSave(
      () =>
        newTemplateVersionFn({
          data: { templateId: editing.template.id, content, schema, note: note || null },
        }),
      "New draft version created.",
    );
  };

  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing?.mode === "edit"
              ? "Edit draft template"
              : editing?.mode === "version"
                ? "New template version"
                : "New template"}
          </DialogTitle>
          <DialogDescription>
            Plain text with {"{{placeholders}}"}. No HTML. Allowed:{" "}
            {ALLOWED_PLACEHOLDERS.slice(0, 5).join(", ")} … ({ALLOWED_PLACEHOLDERS.length} in
            total). Placeholders for clinical values are always required.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {editing?.mode === "new" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="tpl-type">Type</Label>
                <select
                  id="tpl-type"
                  className={selectClass}
                  value={type}
                  onChange={(e) => setType(e.target.value as DocumentType)}
                >
                  <option value="MEDICAL_LETTER">Medical letter</option>
                  <option value="PRESCRIPTION_ORDER">Prescription / order</option>
                </select>
              </div>
              <div>
                <Label htmlFor="tpl-name">Name</Label>
                <Input
                  id="tpl-name"
                  value={name}
                  maxLength={120}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </div>
          )}
          <div>
            <Label htmlFor="tpl-content">Template text</Label>
            <Textarea
              id="tpl-content"
              rows={16}
              className="font-mono text-xs"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="tpl-note">Change note (optional)</Label>
            <Input
              id="tpl-note"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {problems.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              !content.trim() ||
              problems.length > 0 ||
              (editing?.mode === "new" && name.trim().length < 2)
            }
            onClick={() => void save()}
          >
            Save as draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DecisionDialog({
  state,
  onClose,
  onConfirm,
}: {
  state: { template: TemplateRow; approve: boolean } | null;
  onClose: () => void;
  onConfirm: (note: string, until: string) => unknown;
}) {
  const [note, setNote] = useState("");
  const [until, setUntil] = useState("");
  useEffect(() => {
    setNote("");
    setUntil("");
  }, [state]);
  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {state?.approve ? "Approve this wording" : "Send back for changes"}
          </DialogTitle>
          <DialogDescription>
            {state?.approve
              ? "By approving you confirm this wording is acceptable for documents issued under your registration. The previous active version of this template will be archived."
              : "Say what needs to change."}
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor="dec-note">Note{state?.approve ? " (optional)" : ""}</Label>
        <Textarea
          id="dec-note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
        {state?.approve && (
          <div className="max-w-xs">
            <Label htmlFor="dec-until">Valid until (optional)</Label>
            <Input
              id="dec-until"
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!state?.approve && note.trim().length < 3}
            onClick={() => void onConfirm(note, until)}
          >
            {state?.approve ? "Approve" : "Send back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
